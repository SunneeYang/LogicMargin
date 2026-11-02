import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCli } from './logic-margin.ts'
import { addComment, parseReview } from '../src/model.ts'
import { createApprovalRecord, createFeedbackPackage } from '../src/workspace.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession } from '../src/session-types.ts'

function fixture(): ReviewSession {
  const review = addComment(structuredClone(sampleReview), [{ kind: 'review', id: sampleReview.id }], '请核对扣费顺序')
  return { schemaVersion: 1, id: 'session-1', version: 1, round: 1, phase: 'awaiting-review',
    createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', review, history: [],
    snapshots: [{ round: 1, openedAt: '2026-11-02T00:00:00Z', review: structuredClone(review) }] }
}

function output() {
  let out = '', err = ''
  return { io: { out: (value: string) => { out += value }, err: (value: string) => { err += value } },
    get value() { return JSON.parse(out) }, get out() { return out }, get err() { return err } }
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString())
}

async function api(handler: (request: IncomingMessage) => Promise<unknown> | unknown) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request)).then(body => {
      if (body === undefined) { response.writeHead(204); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }).catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })) })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
  } }
}

test('start validates a review and prints a Tailscale session link without putting the graph in stdout', async t => {
  const current = fixture()
  const dir = await mkdtemp(join(tmpdir(), 'logic-margin-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'review.json')
  await writeFile(file, JSON.stringify(current.review))
  const server = await api(async request => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/api/review-sessions')
    assert.deepEqual(await bodyOf(request), { review: current.review })
    return current
  })
  t.after(server.close)
  const result = output()
  await runCli(['start', file, '--url', server.url, '--public-url', 'http://100.124.38.121:5173'], result.io)
  assert.equal(result.value.url, 'http://100.124.38.121:5173/?session=session-1')
  assert.equal(result.value.sessionId, current.id)
  assert.equal('review' in result.value, false)
  assert.match(result.err, /审查地址/)
})

test('wait ignores saved comments, then acknowledges only explicitly submitted feedback', async t => {
  const current = fixture()
  const submitted = createFeedbackPackage(current.review)
  let reads = 0, acknowledged = 0
  const server = await api(async request => {
    if (request.url?.endsWith('/ack')) {
      assert.deepEqual(await bodyOf(request), { submissionId: submitted.id })
      acknowledged++
      return { ...current, history: [submitted], version: 3, phase: 'agent-working', acknowledgedSubmission: submitted.id }
    }
    reads++
    if (reads === 1) return current
    assert.match(request.url ?? '', /afterVersion=1&waitMs=25000/)
    return { ...current, history: [submitted], version: 2, phase: 'feedback-ready' }
  })
  t.after(server.close)
  const result = output()
  await runCli(['wait', current.id, '--url', server.url], result.io)
  assert.equal(reads, 2)
  assert.equal(acknowledged, 1)
  assert.equal(result.value.approved, false)
  assert.equal(result.value.submission.id, submitted.id)
  assert.deepEqual(result.value.submission.review.comments, current.review.comments)
  assert.equal('nodes' in result.value.submission.review, false)
})

test('resume waits past acknowledged feedback, times out safely, and rejects unknown cursors', async t => {
  const current = fixture()
  const submitted = createFeedbackPackage(current.review)
  current.history = [submitted]
  current.acknowledgedSubmission = submitted.id
  let polls = 0
  const server = await api(async request => {
    assert.equal(request.method, 'GET')
    if (!request.url?.includes('?')) return current
    polls++
    await new Promise(resolve => setTimeout(resolve, 10))
    return undefined
  })
  t.after(server.close)
  const result = output()
  await assert.rejects(runCli(['resume', current.id, '--wait', '--timeout', '0.25', '--url', server.url], result.io), /超时/)
  assert.ok(polls > 0)
  assert.equal(result.out, '')
  await assert.rejects(runCli(['wait', current.id, '--after', 'missing', '--url', server.url], result.io), /找不到提交游标/)
})

test('review deadline aborts use the resumable timeout message even before the wall-clock deadline', async t => {
  const current = fixture()
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('?afterVersion=')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return Response.json(current)
  })
  await assert.rejects(runCli(['wait', current.id, '--timeout', '1', '--url', 'http://127.0.0.1:5173'], output().io), /等待审查超时.*resume/)
})

test('wait retains every unacknowledged submission when later feedback contains only new comments', async t => {
  const current = fixture()
  const first = createFeedbackPackage(current.review)
  const next = addComment(current.review, [{ kind: 'review', id: current.review.id }], '还有第二条意见')
  const second = createFeedbackPackage({ ...next, comments: [next.comments.at(-1)!] })
  current.review = next
  current.history = [first, second]
  current.phase = 'feedback-ready'
  const server = await api(async request => {
    if (request.method === 'POST') assert.deepEqual(await bodyOf(request), { submissionId: second.id })
    return current
  })
  t.after(server.close)
  const result = output()
  await runCli(['wait', current.id, '--url', server.url], result.io)
  assert.equal(result.value.submission.id, second.id)
  assert.equal(result.value.earlierSubmissions[0].submission.id, first.id)
  assert.equal(result.value.earlierSubmissions[0].submission.review.comments[0].body, '请核对扣费顺序')
})

test('resume waits for the published round and does not redeliver an old approval or feedback', async t => {
  const current = fixture()
  const first = createFeedbackPackage(current.review)
  const approval = createApprovalRecord({ ...current.review, comments: [] })
  current.history = [first, approval]
  current.acknowledgedSubmission = first.id
  current.round = 2
  current.snapshots.push({ ...structuredClone(current.snapshots[0]), round: 2, afterSubmission: approval.id })
  const second = createFeedbackPackage(current.review)
  let polls = 0
  const server = await api(async request => {
    if (request.method === 'POST') {
      assert.deepEqual(await bodyOf(request), { submissionId: second.id })
      return { ...current, history: [...current.history, second], acknowledgedSubmission: second.id }
    }
    if (!request.url?.includes('?')) return current
    polls++
    return { ...current, history: [...current.history, second], version: 2, phase: 'feedback-ready' }
  })
  t.after(server.close)
  const result = output()
  await runCli(['resume', current.id, '--wait', '--url', server.url], result.io)
  assert.equal(polls, 1)
  assert.equal(result.value.round, 2)
  assert.equal(result.value.submission.id, second.id)
  assert.equal('earlierSubmissions' in result.value, false)
})

test('reply sends a multiline agent reply without a resolve mutation; revise publishes an exact version', async t => {
  const current = fixture()
  const dir = await mkdtemp(join(tmpdir(), 'logic-margin-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bodyFile = join(dir, 'reply.txt'), reviewFile = join(dir, 'next.json')
  await writeFile(bodyFile, '已调整扣费时点。\n\n请复核失败出口。')
  const next = { ...current.review, revision: 'next', snapshot: { ...current.review.snapshot, fingerprint: 'next-fingerprint' } }
  await writeFile(reviewFile, JSON.stringify(next))
  let mutations = 0, revisions = 0
  const server = await api(async request => {
    if (request.url?.endsWith('/mutations')) {
      const payload = await bodyOf(request) as { revision: string; fingerprint: string; mutations: { kind: string; reply: { author: string; body: string } }[] }
      assert.equal(payload.revision, current.review.revision)
      assert.equal(payload.fingerprint, current.review.snapshot.fingerprint)
      assert.equal(payload.mutations.length, 1)
      assert.equal(payload.mutations[0].kind, 'add-reply')
      assert.equal(payload.mutations[0].reply.author, 'agent')
      assert.equal(payload.mutations[0].reply.body, '已调整扣费时点。\n\n请复核失败出口。')
      mutations++
      return { ...current, version: 2 }
    }
    if (request.url?.endsWith('/revise')) {
      assert.deepEqual(await bodyOf(request), { expectedVersion: 1, review: parseReview(next) })
      revisions++
      return { ...current, version: 2, round: 2, review: next }
    }
    return current
  })
  t.after(server.close)
  await runCli(['reply', current.id, current.review.comments[0].id, '--body-file', bodyFile, '--url', server.url], output().io)
  const result = output()
  await runCli(['revise', current.id, reviewFile, '--url', server.url], result.io)
  assert.equal(mutations, 1)
  assert.equal(revisions, 1)
  assert.equal(result.value.round, 2)
})

test('CLI rejects unsupported commands and invalid options before contacting a server', async () => {
  for (const args of [['resolve', 'id'], ['get', 'id', '--wait'], ['wait', 'id', '--timeout', '0'], ['get', 'id', '--url', 'file:///tmp/review']]) {
    await assert.rejects(runCli(args, output().io))
  }
})
