import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createSessionApi } from './api.ts'
import { sampleReview } from '../src/sample.ts'
import { addComment } from '../src/model.ts'

test('HTTP review channel validates origins and supports atomic publication and review gates', async t => {
  const dataDir = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-api-'))
  const api = createSessionApi({ dataDir })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }) })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const badOrigin = await post('/api/review-sessions', { review: sampleReview }, { origin: 'https://evil.example' })
  assert.equal(badOrigin.status, 403)
  const wrongType = await fetch(`${base}/api/review-sessions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(wrongType.status, 415)
  const review = structuredClone(sampleReview); review.comments = []
  const created = await post('/api/review-sessions', { review }, { origin: base })
  assert.equal(created.status, 201)
  const session = await created.json()
  const path = `/api/review-sessions/${session.id}`
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '整体逻辑评审').comments.at(-1)!
  const savedResponse = await post(`${path}/mutations`, { revision: review.revision, fingerprint: review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }] })
  assert.equal(savedResponse.status, 200)
  const saved = await savedResponse.json()
  assert.equal(saved.history.length, 0)
  assert.equal((await fetch(`${base}${path}?afterVersion=${saved.version}&waitMs=1`)).status, 204)
  const finished = await post(`${path}/finish`, { expectedVersion: saved.version, kind: 'feedback' })
  assert.equal(finished.status, 200)
  const ready = await (await fetch(`${base}${path}?afterVersion=${saved.version}&waitMs=1`)).json()
  assert.equal(ready.phase, 'feedback-ready')
  assert.equal(ready.history.length, 1)
  assert.equal(ready.review.comments[0].originRound, 1)
  const cannotApprove = await post(`${path}/finish`, { expectedVersion: ready.version, kind: 'approval' })
  assert.equal(cannotApprove.status, 409)
  assert.equal((await post(`${path}/revise`, { expectedVersion: ready.version, review })).status, 400)
  const sourceDigest = createHash('sha256').update('reviewed fixture\n').digest('hex')
  const files = [{ path: 'source.ts', sha256: sourceDigest }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  const nextReview = structuredClone(review)
  nextReview.snapshot = { ...nextReview.snapshot, files, fingerprint }
  nextReview.nodes.forEach(node => { node.evidence = [] })
  nextReview.nodes[0].summary += ' 本轮修改后的业务条件'
  const request = { expectedVersion: ready.version, review: nextReview,
    publication: { baseRound: 1, summary: '同步更新本轮业务条件', source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } },
    replies: [{ commentId: comment.id, body: '已完成修改，请复核新版图' }] }
  const invalid = await post(`${path}/revise`, { ...request, replies: [...request.replies, { commentId: 'unknown', body: 'invalid' }] })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await (await fetch(`${base}${path}`)).json(), ready)
  const publishedResponse = await post(`${path}/revise`, request)
  assert.equal(publishedResponse.status, 200)
  const published = await publishedResponse.json()
  assert.equal(published.round, 2)
  assert.equal(published.phase, 'awaiting-review')
  assert.equal(published.review.comments[0].originRound, 1)
  assert.equal(published.review.comments[0].replies[0].round, 2)
  assert.deepEqual(published.history, ready.history)
  assert.deepEqual(published.snapshots[1].publication, request.publication)
  const mutation = { expectedVersion: published.version, round: 2, revision: nextReview.revision, fingerprint,
    mutations: [{ kind: 'set-status', commentId: comment.id, from: 'needs-review', status: 'resolved', reviewedRevision: nextReview.revision }] }
  const { round: _round, ...legacyMutation } = mutation
  assert.equal((await post(`${path}/mutations`, legacyMutation)).status, 409)
  assert.equal((await post(`${path}/mutations`, { ...mutation, round: 1 })).status, 409)
  const resolvedResponse = await post(`${path}/mutations`, mutation)
  assert.equal(resolvedResponse.status, 200)
  const resolved = await resolvedResponse.json()
  assert.equal(resolved.review.comments[0].reviewedRound, 2)
  assert.equal((await post(`${path}/finish`, { expectedVersion: resolved.version, kind: 'approval' })).status, 200)
  assert.equal((await fetch(`${base}${path}/unknown`)).status, 404)
})

test('current view omits frozen documents and serves snapshots and records on demand', async t => {
  const dataDir = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-current-api-'))
  const api = createSessionApi({ dataDir })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/review-sessions`
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }) })
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.ok(response.ok, await response.clone().text())
    return response.json()
  }
  const review = structuredClone(sampleReview); review.comments = []
  const created = await post('?view=current', { review })
  assert.equal(created.view, 'current')
  assert.equal(created.snapshots[0].review, undefined)
  assert.deepEqual(created.submittedCommentIds, [])
  const path = `/${created.id}`
  const comment = addComment(review, [{ kind: 'node', id: review.nodes[0].id }], '新接口仍保留原始线程').comments[0]
  const saved = await post(`${path}/mutations?view=current`, { round: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }] })
  assert.deepEqual(saved.commentOrigins, [{ commentId: comment.id, round: 1, exact: true }])
  const polling = fetch(`${base}${path}?view=current&afterVersion=${saved.version}&waitMs=1000`).then(response => response.json())
  const submitted = await post(`${path}/finish?view=current`, { expectedVersion: saved.version, kind: 'feedback' })
  assert.equal(submitted.history[0].review, undefined)
  assert.deepEqual(submitted.history[0], { id: submitted.history[0].id, kind: 'logic-margin-feedback', createdAt: submitted.history[0].createdAt,
    round: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint })
  assert.deepEqual(submitted.submittedCommentIds, [comment.id])
  const observed = await polling
  assert.equal(observed.view, 'current')
  assert.equal(observed.version, submitted.version)
  assert.equal(observed.history[0].review, undefined)
  const snapshotResponse = await fetch(`${base}${path}/snapshots/1`)
  assert.equal(snapshotResponse.status, 200)
  assert.deepEqual((await snapshotResponse.json()).review.comments, [])
  const recordPath = `${base}${path}/records/${submitted.history[0].id}`
  const record = await (await fetch(recordPath)).json()
  assert.equal(record.review.comments[0].body, comment.body)
  assert.equal(record.review.comments[0].status, 'open')
  assert.equal((await fetch(`${base}${path}/snapshots/2`)).status, 404)
  assert.equal((await fetch(`${base}${path}/snapshots/0`)).status, 400)
  assert.equal((await fetch(`${base}${path}/records/unknown`)).status, 404)
  assert.equal((await fetch(recordPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405)
  const legacy = await (await fetch(`${base}${path}`)).json()
  assert.equal(legacy.view, undefined)
  assert.equal(legacy.history[0].review.comments[0].body, comment.body)
  assert.equal(legacy.snapshots[0].review.id, review.id)
})
