import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { runCli } from './logic-margin.ts'
import { addComment, parseReview } from '../src/model.ts'
import { createApprovalRecord, createFeedbackPackage } from '../src/workspace.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession, ReviseRequest } from '../src/session-types.ts'

function fixture(): ReviewSession {
  const review = addComment(structuredClone(sampleReview), [{ kind: 'review', id: sampleReview.id }], '请核对扣费顺序')
  return { schemaVersion: 1, id: 'session-1', version: 1, round: 1, phase: 'awaiting-review',
    createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', review, history: [],
    snapshots: [{ round: 1, openedAt: '2026-11-02T00:00:00Z', review: structuredClone(review) }] }
}

async function revisionFixture(t: TestContext, current = fixture()) {
  const dir = await mkdtemp(join(tmpdir(), 'logic-margin-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const content = 'check()\nchargeAfterSuccess()\n'
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const files = [{ path: 'logic.ts', sha256: digest(content) }]
  const next = structuredClone(current.review)
  next.revision = 'next'
  next.nodes.forEach(node => { node.evidence = [] })
  next.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'check', startLine: 1, endLine: 2, digest: digest(content.slice(0, -1)) }]
  next.snapshot.files = files
  next.snapshot.fingerprint = digest(JSON.stringify(files))
  const review = parseReview(next)
  const reviewFile = join(dir, 'next.json')
  await writeFile(join(dir, 'logic.ts'), content)
  await writeFile(reviewFile, JSON.stringify(review))
  return { dir, reviewFile, next: review }
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
  const { dir, reviewFile, next } = await revisionFixture(t, current)
  const bodyFile = join(dir, 'reply.txt'), repliesFile = join(dir, 'replies.json')
  await writeFile(bodyFile, '已调整扣费时点。\n\n请复核失败出口。')
  const replies = [{ commentId: current.review.comments[0].id, body: '已同步新流程。\n\n请在新版复核。' }]
  await writeFile(repliesFile, JSON.stringify(replies))
  let mutations = 0, revisions = 0
  const server = await api(async request => {
    if (request.url?.endsWith('/mutations')) {
      const payload = await bodyOf(request) as { round: number; revision: string; fingerprint: string; mutations: { kind: string; reply: { author: string; body: string } }[] }
      assert.equal(payload.round, current.round)
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
      const payload = await bodyOf(request) as ReviseRequest
      assert.equal(payload.expectedVersion, current.version)
      assert.deepEqual(payload.review, next)
      assert.equal(payload.publication.baseRound, current.round)
      assert.equal(payload.publication.summary, '改为成功后扣费')
      assert.equal(payload.publication.unchangedReason, '此项用于说明确认过的原有流程')
      assert.equal(payload.publication.source.algorithm, 'sha256-path-content-v1')
      assert.ok(Number.isFinite(Date.parse(payload.publication.source.checkedAt)))
      assert.deepEqual(payload.publication.source.files, next.snapshot.files)
      assert.equal(payload.publication.source.fingerprint, next.snapshot.fingerprint)
      assert.deepEqual(payload.replies, replies)
      revisions++
      return { ...current, version: 2, round: 2, review: next }
    }
    return current
  })
  t.after(server.close)
  await runCli(['reply', current.id, current.review.comments[0].id, '--body-file', bodyFile, '--url', server.url], output().io)
  const result = output()
  await runCli(['revise', current.id, reviewFile, '--source-root', dir, '--base-round', '1', '--summary', ' 改为成功后扣费 ',
    '--unchanged-reason', '此项用于说明确认过的原有流程', '--replies-file', repliesFile, '--url', server.url], result.io)
  assert.equal(mutations, 1)
  assert.equal(revisions, 1)
  assert.equal(result.value.round, 2)
})

test('verify checks source provenance offline and prints a complete manifest', async t => {
  const { dir, reviewFile, next } = await revisionFixture(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected network access') })
  const result = output()
  await runCli(['verify', reviewFile, '--source-root', dir, '--url', 'http://127.0.0.1:1'], result.io)
  assert.equal(requests, 0)
  assert.equal(result.value.algorithm, 'sha256-path-content-v1')
  assert.deepEqual(result.value.files, next.snapshot.files)
  assert.equal(result.value.fingerprint, next.snapshot.fingerprint)
  assert.equal(result.err, '')
})

test('revise rejects stale source and invalid final replies before contacting a service', async t => {
  const { dir, reviewFile } = await revisionFixture(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected network access') })
  await writeFile(join(dir, 'logic.ts'), 'oldGraphNoLongerMatches()\n')
  const args = ['revise', 'session-1', reviewFile, '--source-root', dir, '--base-round', '1', '--summary', '改为成功后扣费', '--url', 'http://127.0.0.1:1']
  await assert.rejects(runCli(args, output().io), /来源文件已变化/)
  await writeFile(join(dir, 'logic.ts'), 'check()\nchargeAfterSuccess()\n')
  const repliesFile = join(dir, 'replies.json')
  await writeFile(repliesFile, JSON.stringify([{ commentId: 'comment-1', body: '  ' }]))
  await assert.rejects(runCli([...args, '--replies-file', repliesFile], output().io), /发布回复须包含/)
  assert.equal(requests, 0)
})

test('revise requires the reviewed round and refuses a stale draft before publication', async t => {
  const { dir, reviewFile } = await revisionFixture(t)
  await assert.rejects(runCli(['revise', 'session-1', reviewFile, '--summary', '改为成功后扣费'], output().io), /需要 --base-round/)
  const current = fixture()
  current.round = 2
  current.snapshots.push({ ...structuredClone(current.snapshots[0]), round: 2 })
  let publications = 0
  const server = await api(request => {
    if (request.method === 'POST') publications++
    return current
  })
  t.after(server.close)
  await assert.rejects(runCli(['revise', current.id, reviewFile, '--source-root', dir, '--base-round', '1',
    '--summary', '改为成功后扣费', '--url', server.url], output().io), /基于第 1 轮.*会话已是第 2 轮/)
  assert.equal(publications, 0)
})

test('CLI rejects unsupported commands and invalid options before contacting a server', async () => {
  for (const args of [['resolve', 'id'], ['get', 'id', '--wait'], ['wait', 'id', '--timeout', '0'], ['get', 'id', '--url', 'file:///tmp/review'],
    ['revise', 'id', 'review.json'], ['revise', 'id', 'review.json', '--base-round', '1', '--summary', '  '], ['verify', 'review.json', '--wait'],
    ['get', 'id', '--source-root', '.'], ['get', 'id', '--summary', 'summary'], ['start', 'review.json', '--replies-file', 'replies.json'],
    ['get', 'id', '--base-round', '1'], ['start', 'review.json', '--base-round', '1'], ['verify', 'review.json', '--base-round', '1'],
    ['revise', 'id', 'review.json', '--base-round', '0'], ['revise', 'id', 'review.json', '--base-round', '1.5'],
    ['revise', 'id', 'review.json', '--base-round', '51']]) {
    await assert.rejects(runCli(args, output().io))
  }
})
