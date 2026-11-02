import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionApi } from './api.ts'
import { sampleReview } from '../src/sample.ts'
import { addComment } from '../src/model.ts'

test('HTTP review channel validates origins and supports create/save/finish/get/long-poll', async t => {
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
  assert.equal((await fetch(`${base}${path}/unknown`)).status, 404)
})
