import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionStore } from './session-store.ts'
import { createSessionApi } from './api.ts'
import { addComment } from '../src/model.ts'
import { createApprovalRecord } from '../src/workspace.ts'
import { sampleReview } from '../src/sample.ts'

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-lifecycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { store: new SessionStore(directory), directory }
}

test('different review purposes in the same context have independent comments, rounds and cleanup', async t => {
  const { store, directory } = await setup(t)
  const incoming = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], '旧目的的意见')
  const first = await store.create(incoming, 'current', { scope: { context: 'thread-1', purpose: '扣费时机' }, cleanupPolicy: 'archive-on-approval' })
  const second = await store.create(incoming, 'current', { scope: { context: 'thread-1', purpose: '异常回滚' } })
  const other = await store.create(sampleReview, 'current', { scope: { context: 'thread-2', purpose: '扣费时机' } })
  assert.notEqual(first.id, second.id)
  assert.equal(first.review.comments.length, 0)
  assert.equal(second.review.comments.length, 0)
  assert.deepEqual(first.scope, { context: 'thread-1', purpose: '扣费时机' })
  assert.equal(first.cleanupPolicy, 'archive-on-approval')
  assert.equal((await store.list({ context: 'thread-1' })).sessions.length, 2)
  const finished = await store.finish(first.id, { expectedVersion: first.version, kind: 'approval' })
  await store.cleanup(first.id, { expectedVersion: finished.version, mode: 'delete' })
  assert.deepEqual(await store.get(second.id, 'current'), second)
  assert.deepEqual(await new SessionStore(directory).get(other.id, 'current'), other)
  await assert.rejects(store.get(first.id), { status: 404 })
})

test('HTTP baseline resources preserve old sessions and expose fixed graphs separately from current responses', async t => {
  const { directory } = await setup(t)
  const api = createSessionApi({ dataDir: directory })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/review-sessions`
  const post = (path: string, body: unknown, origin?: string) => fetch(`${base}${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  const review = { ...structuredClone(sampleReview), comments: [] }
  const baseline = { ...structuredClone(review), revision: 'original-code' }
  assert.equal((await post('', { review, baselineReview: true })).status, 400)
  assert.equal((await post('', { review, baselineReview: false })).status, 400)
  assert.equal((await post('', { review: { ...review, baseline }, baselineReview: true })).status, 400)
  const baselineFirst = await (await post('?view=current', { review: { ...review, baseline: structuredClone(review) }, baselineReview: true })).json()
  assert.equal(baselineFirst.baselineReview, true)
  assert.equal(baselineFirst.round, 1)
  assert.equal((await post(`/${baselineFirst.id}/finish`, { expectedVersion: baselineFirst.version, kind: 'approval' })).status, 409)
  const first = await (await post('?view=current', { review })).json()
  assert.equal(first.round, 1)
  assert.equal(first.baseline, undefined)
  assert.equal((await fetch(`${base}/${first.id}/baseline`)).status, 404)
  const input = { expectedVersion: first.version, baseline }
  assert.equal((await post(`/${first.id}/baseline`, input, 'https://elsewhere.invalid')).status, 403)
  assert.equal((await post(`/${first.id}/baseline`, { ...input, expectedVersion: first.version + 1 })).status, 409)
  const response = await post(`/${first.id}/baseline?view=current`, input)
  assert.equal(response.status, 200)
  const attached = await response.json()
  assert.equal(attached.round, first.round)
  assert.equal(attached.version, first.version + 1)
  assert.equal(attached.review.baseline, undefined)
  assert.equal(attached.baseline.revision, baseline.revision)
  assert.deepEqual((await (await fetch(`${base}/${first.id}/baseline`)).json()).review, baseline)
  assert.deepEqual((await (await fetch(`${base}/${first.id}`)).json()).review.baseline, baseline)
  assert.equal((await post(`/${first.id}/baseline`, { expectedVersion: attached.version, baseline: { ...baseline, revision: 'other-code' } })).status, 409)
  const createdWithBaseline = await (await post('?view=current', { review: { ...review, baseline } })).json()
  assert.equal(createdWithBaseline.round, 1)
  assert.equal(createdWithBaseline.baseline.revision, baseline.revision)
  assert.equal(createdWithBaseline.review.baseline, undefined)
})

test('archive removes active data, is recoverable across restart, and permanent deletion removes the archive', async t => {
  const { store, directory } = await setup(t)
  const created = await store.create({ ...sampleReview, comments: [] }, undefined, { scope: { purpose: '完整归档' } })
  const approved = await store.finish(created.id, { expectedVersion: created.version, kind: 'approval' })
  const archived = await store.cleanup(created.id, { expectedVersion: approved.version, mode: 'archive' })
  assert.ok(archived.archivedAt)
  await assert.rejects(readFile(join(directory, `${created.id}.json`)), { code: 'ENOENT' })
  await assert.rejects(store.get(created.id), { status: 410 })
  assert.deepEqual(await store.getArchive(created.id), approved)
  assert.equal((await store.list()).sessions.length, 0)
  const archivedList = (await store.list({ state: 'all' })).sessions
  assert.equal(archivedList[0].archivedAt, archived.archivedAt)
  assert.equal(archivedList[0].scope?.purpose, '完整归档')
  const restarted = new SessionStore(directory)
  const restored = await restarted.restore(created.id, { expectedVersion: approved.version })
  assert.equal(restored.version, approved.version + 1)
  assert.deepEqual(restored.history, approved.history)
  assert.deepEqual(restored.snapshots, approved.snapshots)
  await assert.rejects(restarted.getArchive(created.id), { status: 404 })
  await restarted.cleanup(created.id, { expectedVersion: restored.version, mode: 'archive' })
  await restarted.cleanup(created.id, { expectedVersion: restored.version, mode: 'delete' })
  assert.deepEqual(await restarted.list({ state: 'all' }), { sessions: [] })
  await assert.rejects(restarted.getArchive(created.id), { status: 404 })
})

test('cleanup is version guarded, unfinished reviews require explicit intent, and new opinions prevent automatic cleanup', async t => {
  const { store } = await setup(t)
  const created = await store.create({ ...sampleReview, comments: [] })
  await assert.rejects(store.cleanup(created.id, { expectedVersion: created.version, mode: 'archive' }), { status: 409 })
  assert.throws(() => store.cleanup(created.id, { expectedVersion: created.version, mode: 'delete', allowUnfinished: 'true' }), /选项无效/)
  const approved = await store.finish(created.id, { expectedVersion: created.version, kind: 'approval' })
  const comment = addComment(approved.review, [{ kind: 'review', id: approved.review.id }], '新的意见').comments.at(-1)!
  const updated = await store.mutate(created.id, { round: 1, revision: approved.review.revision, fingerprint: approved.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }] })
  await assert.rejects(store.cleanup(created.id, { expectedVersion: approved.version, mode: 'archive' }), { status: 409 })
  await assert.rejects(store.cleanup(created.id, { expectedVersion: updated.version, mode: 'archive' }), { status: 409 })
  assert.deepEqual(await store.get(created.id), updated)
  await store.cleanup(created.id, { expectedVersion: updated.version, mode: 'archive', allowUnfinished: true })
  assert.equal((await store.getArchive(created.id)).review.comments[0].body, '新的意见')
})

test('cleanup wakes existing long polls and delayed mutations cannot recreate the deleted task', async t => {
  const { store } = await setup(t)
  const created = await store.create({ ...sampleReview, comments: [] })
  const approved = await store.finish(created.id, { expectedVersion: created.version, kind: 'approval' })
  const watching = store.waitForChange(created.id, approved.version, 25000)
  const rejection = assert.rejects(watching, { status: 404 })
  await store.cleanup(created.id, { expectedVersion: approved.version, mode: 'delete' })
  await rejection
  const comment = addComment(approved.review, [{ kind: 'review', id: approved.review.id }], '延迟到达').comments.at(-1)!
  await assert.rejects(store.mutate(created.id, { round: 1, revision: approved.review.revision, fingerprint: approved.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }] }), { status: 404 })
})

test('server reloads more than fifty rounds and fixed results without truncating them', async t => {
  const { store, directory } = await setup(t)
  const created = await store.create({ ...sampleReview, comments: [] })
  const seeded = { ...created, round: 60, history: Array.from({ length: 60 }, () => createApprovalRecord(created.review)),
    snapshots: Array.from({ length: 60 }, (_, index) => ({ round: index + 1, openedAt: created.createdAt, review: created.review })) }
  await writeFile(join(directory, `${created.id}.json`), JSON.stringify(seeded))
  const current = await store.get(created.id)
  assert.equal(current.round, 60)
  const approved = await store.finish(created.id, { expectedVersion: current.version, kind: 'approval' })
  assert.equal(approved.history.length, 61)
  assert.equal((await new SessionStore(directory).get(created.id)).snapshots.length, 60)
})

test('a damaged task cannot prevent managing healthy tasks and both damaged originals survive', async t => {
  const { store, directory } = await setup(t)
  const broken = await store.create({ ...sampleReview, comments: [] })
  const archived = await store.create({ ...sampleReview, comments: [] })
  await store.cleanup(archived.id, { expectedVersion: archived.version, mode: 'archive', allowUnfinished: true })
  const healthy = await store.create({ ...sampleReview, comments: [] }, undefined, { scope: { context: 'good-context', purpose: '可继续管理' } })
  const damagedActive = join(directory, `${broken.id}.json`)
  const damagedArchive = join(directory, 'archive', `${archived.id}.json.gz`)
  await writeFile(damagedActive, 'broken active JSON')
  await writeFile(damagedArchive, 'broken compressed archive')
  const result = await store.list({ context: 'good-context', state: 'all' })
  assert.deepEqual(result.sessions.map(item => item.id), [healthy.id])
  assert.equal(result.warnings?.length, 2)
  assert.equal(await readFile(damagedActive, 'utf8'), 'broken active JSON')
  assert.equal(await readFile(damagedArchive, 'utf8'), 'broken compressed archive')
  await store.cleanup(healthy.id, { expectedVersion: healthy.version, mode: 'archive', allowUnfinished: true })
  assert.equal((await store.list({ context: 'good-context', state: 'all' })).sessions[0].id, healthy.id)
})

test('lifecycle HTTP operations validate scope, origin, verbs and concurrency', async t => {
  const { directory } = await setup(t)
  const api = createSessionApi({ dataDir: directory })
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/review-sessions`
  const post = (path: string, body: unknown, origin?: string) => fetch(`${base}${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  assert.equal((await post('', { review: sampleReview, scope: { purpose: ' ' } })).status, 400)
  const response = await post('', { review: sampleReview, scope: { context: 'http-test', purpose: '接口审查' }, cleanupPolicy: 'archive-on-approval' })
  assert.equal(response.status, 201)
  const created = await response.json()
  assert.equal(created.review.comments.length, 0)
  assert.equal((await (await fetch(`${base}?context=http-test`)).json()).sessions.length, 1)
  assert.equal((await fetch(`${base}?state=invalid`)).status, 400)
  const approved = await (await post(`/${created.id}/finish`, { expectedVersion: created.version, kind: 'approval' })).json()
  const cleanup = { expectedVersion: approved.version, mode: 'archive' }
  assert.equal((await post(`/${created.id}/cleanup`, cleanup, 'https://elsewhere.invalid')).status, 403)
  assert.equal((await post(`/${created.id}/cleanup`, { ...cleanup, expectedVersion: 1 })).status, 409)
  assert.equal((await post(`/${created.id}/cleanup`, cleanup)).status, 200)
  assert.equal((await fetch(`${base}/${created.id}`)).status, 410)
  assert.deepEqual(await (await fetch(`${base}/${created.id}/archive`)).json(), approved)
  assert.equal((await post(`/${created.id}/archive`, {})).status, 405)
  assert.equal((await post(`/${created.id}/restore`, { expectedVersion: approved.version })).status, 200)
  assert.equal((await fetch(`${base}/${created.id}`)).status, 200)
})
