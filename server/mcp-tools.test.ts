import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { registerReviewTools } from './mcp-tools.ts'
import { createReviewServer } from './runtime.ts'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewDocument } from '../src/types.ts'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const pause = () => new Promise(resolve => setTimeout(resolve, 40))
type Result = Awaited<ReturnType<Client['callTool']>>
const resultText = (result: Result) => CallToolResultSchema.parse(result).content.filter(item => item.type === 'text').map(item => item.text).join('\n')

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-tools-'))
  const service = await createReviewServer({ dataDir: join(directory, 'sessions'), instanceId: 'tools-test', version: 'tools-test',
    shutdownToken: 'tools-owner', assets: { '/index.html': { body: Buffer.from('<html>tools</html>').toString('base64'), type: 'text/html' } } })
  const server = new McpServer({ name: 'logic-margin-tools-test', version: '1.0.0' })
  registerReviewTools(server, { url: () => service.url })
  const client = new Client({ name: 'tools-test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close(); await service.close(); await rm(directory, { recursive: true, force: true }) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, resultText(result))
    return JSON.parse(resultText(result))
  }
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${service.url}/api/review-sessions${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const value = await response.json()
    assert.ok(response.ok, JSON.stringify(value))
    return value
  }
  const reviewFile = join(directory, 'review.json')
  const source = async (content = 'check()\nrun()\n', previous: ReviewDocument = sampleReview) => {
    await writeFile(join(directory, 'logic.ts'), content)
    const review = structuredClone(previous)
    review.comments = []
    review.nodes.forEach(node => { node.evidence = [] })
    const files = [{ path: 'logic.ts', sha256: sha256(content) }]
    review.snapshot = { ...review.snapshot, repository: directory, commit: 'tools-fixture', files, fingerprint: sha256(JSON.stringify(files)) }
    await writeFile(reviewFile, JSON.stringify(review))
    return review
  }
  return { directory, reviewFile, client, call, api, source }
}

test('review tools expose bounded schemas and reject relative files, extra destinations and stale sources', async t => {
  const { directory, reviewFile, client, call, source } = await setup(t)
  await source()
  const catalog = await client.listTools()
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [
    'acknowledge_review', 'attach_review_baseline', 'cleanup_review', 'get_review', 'list_reviews', 'reply_review',
    'restore_review', 'revise_review', 'start_review', 'verify_review', 'wait_review',
  ])
  assert.equal(catalog.tools.find(tool => tool.name === 'wait_review')!.annotations!.readOnlyHint, true)
  assert.equal(catalog.tools.find(tool => tool.name === 'reply_review')!.annotations!.readOnlyHint, false)
  assert.equal(catalog.tools.find(tool => tool.name === 'cleanup_review')!.annotations!.destructiveHint, true)
  const args = { review_file: reviewFile, source_root: directory, purpose: '核对工具输入边界' }
  for (const invalid of [{ ...args, review_file: 'review.json' }, { ...args, url: 'http://unrelated.example' }]) {
    const result = await client.callTool({ name: 'start_review', arguments: invalid })
    assert.equal(result.isError, true)
  }
  await writeFile(join(directory, 'logic.ts'), 'changed()\n')
  const stale = await client.callTool({ name: 'start_review', arguments: args })
  assert.equal(stale.isError, true)
  assert.match(resultText(stale), /来源文件已变化/)
  assert.equal((await call('list_reviews', {})).sessions.length, 0)
})

test('MCP creates R1 with a separately verified baseline and can attach B to an existing R1', async t => {
  const { directory, reviewFile, client, call, source } = await setup(t)
  const review = await source()
  const baselineRoot = join(directory, 'before-source')
  await mkdir(baselineRoot)
  const beforeContent = 'checkBefore()\nrunBefore()\n'
  const baseline = structuredClone(review)
  baseline.revision = 'before-task'
  baseline.nodes[0].summary = '任务开始前的规则。'
  baseline.snapshot.files = [{ path: 'logic.ts', sha256: sha256(beforeContent) }]
  baseline.snapshot.fingerprint = sha256(JSON.stringify(baseline.snapshot.files))
  const baselineFile = join(directory, 'before.json')
  await writeFile(join(baselineRoot, 'logic.ts'), beforeContent)
  await writeFile(baselineFile, JSON.stringify(baseline))
  const args = { review_file: reviewFile, source_root: directory, baseline_file: baselineFile }
  const missingRoot = await client.callTool({ name: 'start_review', arguments: { ...args, purpose: '缺旧树应停止' } })
  assert.equal(missingRoot.isError, true)
  assert.match(resultText(missingRoot), /需要 --baseline-source-root/)
  assert.equal((await call('list_reviews', {})).sessions.length, 0)
  const verified = await call('verify_review', { ...args, baseline_source_root: baselineRoot })
  assert.equal(verified.baseline.fingerprint, baseline.snapshot.fingerprint)
  const started = await call('start_review', { ...args, baseline_source_root: baselineRoot, purpose: '核对首轮固定基线' })
  const first = await call('get_review', { session_id: started.sessionId })
  assert.equal(first.round, 1)
  assert.deepEqual(first.review.baseline, baseline)

  const legacy = await call('start_review', { review_file: reviewFile, source_root: directory, purpose: '补录首轮基线' })
  const attached = await call('attach_review_baseline', { session_id: legacy.sessionId, baseline_file: baselineFile, source_root: baselineRoot })
  assert.equal(attached.sessionId, legacy.sessionId)
  assert.equal(attached.round, 1)
  assert.equal(attached.version, 2)
  const saved = await call('get_review', { session_id: legacy.sessionId })
  assert.deepEqual(saved.review.baseline, baseline)
  await writeFile(join(baselineRoot, 'logic.ts'), 'unexpected edit\n')
  const stale = await client.callTool({ name: 'attach_review_baseline', arguments: {
    session_id: legacy.sessionId, baseline_file: baselineFile, source_root: baselineRoot,
  } })
  assert.equal(stale.isError, true)
  assert.match(resultText(stale), /来源文件已变化/)
  assert.equal((await call('get_review', { session_id: legacy.sessionId })).version, saved.version)
})

test('baseline-first MCP review collects redesign feedback on B and publishes actual implementation as R1', async t => {
  const { directory, reviewFile, call, api, source } = await setup(t)
  const original = await source('check()\nchargeBeforeSuccess()\n')
  const started = await call('start_review', { review_file: reviewFile, source_root: directory,
    baseline_review: true, purpose: '先审原系统，再提出改造' })
  assert.equal(started.baselineReview, true)
  const first = await call('get_review', { session_id: started.sessionId })
  assert.equal(first.round, 1)
  assert.equal(first.baselineReview, true)
  assert.deepEqual(first.review.baseline, original)
  const comment = addComment(first.review, [{ kind: 'node', id: original.nodes[0].id }], '请改为执行成功后扣费。', 'baseline').comments[0]
  const saved = await api(`/${started.sessionId}/mutations`, { round: first.round, revision: first.review.revision,
    fingerprint: first.review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }] })
  assert.equal(saved.review.comments[0].basis, 'baseline')
  const submitted = await api(`/${started.sessionId}/finish`, { expectedVersion: saved.version, kind: 'feedback' })
  const received = await call('wait_review', { session_id: started.sessionId })
  assert.equal(received.baselineReview, true)
  assert.equal(received.submission.review.comments[0].basis, 'baseline')
  await call('acknowledge_review', { session_id: started.sessionId, submission_id: submitted.history[0].id })

  const implemented = await source('check()\nrun()\nchargeAfterSuccess()\n', first.review)
  implemented.revision = 'implemented-r1'
  implemented.nodes[0].summary = '执行成功后再扣费。'
  await writeFile(reviewFile, JSON.stringify(implemented))
  const revised = await call('revise_review', { session_id: started.sessionId, review_file: reviewFile,
    source_root: directory, base_round: first.round, summary: '已修改真实执行顺序并核验当前源码' })
  assert.equal(revised.round, 2)
  assert.equal(revised.baselineReview, true)
  const current = await call('get_review', { session_id: started.sessionId })
  assert.deepEqual(current.review.baseline, original)
  assert.equal(current.review.nodes[0].summary, implemented.nodes[0].summary)
  assert.equal(current.review.comments[0].basis, 'baseline')
})

test('MCP review lifecycle waits for submission, explicitly acknowledges and keeps approval until cleanup', async t => {
  const { directory, reviewFile, client, call, api, source } = await setup(t)
  const review = await source()
  const verified = await call('verify_review', { review_file: reviewFile, source_root: directory })
  assert.equal(verified.fingerprint, review.snapshot.fingerprint)
  const started = await call('start_review', { review_file: reviewFile, source_root: directory, purpose: '核对单服务评审',
    context: 'tools-context', public_url: 'http://100.64.0.9:5173', cleanup_on_approval: true })
  assert.equal(started.url, `http://100.64.0.9:5173/?session=${started.sessionId}`)
  assert.equal((await call('list_reviews', { context: 'tools-context' })).sessions.length, 1)
  const path = `/${started.sessionId}`
  let completed = false
  const waiting = client.callTool({ name: 'wait_review', arguments: { session_id: started.sessionId } }).then(result => { completed = true; return result })
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '失败出口也要保持原状态。').comments.at(-1)!
  const saved = await api(`${path}/mutations`, { revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }] })
  await pause()
  assert.equal(completed, false, 'Saving an individual comment must not complete the tool')
  const submitted = await api(`${path}/finish`, { expectedVersion: saved.version, kind: 'feedback' })
  const received = await waiting
  assert.ok(!received.isError, resultText(received))
  const feedback = JSON.parse(resultText(received))
  assert.equal(feedback.submission.id, submitted.history[0].id)
  assert.equal(feedback.submission.review.comments[0].body, comment.body)
  const unread = await call('get_review', { session_id: started.sessionId })
  assert.equal(unread.phase, 'feedback-ready')
  assert.equal(unread.acknowledgedSubmission, undefined)
  assert.equal((await call('wait_review', { session_id: started.sessionId })).submission.id, feedback.submission.id, 'A lost result remains readable until explicitly acknowledged')
  const claimed = await call('acknowledge_review', { session_id: started.sessionId, submission_id: feedback.submission.id })
  assert.equal(claimed.phase, 'agent-working')
  await call('acknowledge_review', { session_id: started.sessionId, submission_id: feedback.submission.id })
  await call('reply_review', { session_id: started.sessionId, comment_id: comment.id, body: '--help' })
  assert.equal((await call('get_review', { session_id: started.sessionId })).review.comments[0].replies[0].body, '--help')

  const next = await source('check()\nrun()\npreserve()\n', review)
  next.revision = 'mcp-tools-v2'
  next.nodes[0].detail += ' 失败保留状态。'
  await writeFile(reviewFile, JSON.stringify(next))
  const repliesFile = join(directory, 'replies.json')
  await writeFile(repliesFile, JSON.stringify([{ commentId: comment.id, body: '已补充失败出口，请复核新版。' }]))
  const revisionArgs = { session_id: started.sessionId, review_file: reviewFile, source_root: directory,
    base_round: 1, summary: '补充失败出口', replies_file: repliesFile }
  const revised = await call('revise_review', revisionArgs)
  assert.equal(revised.round, 2)
  const stale = await client.callTool({ name: 'revise_review', arguments: revisionArgs })
  assert.equal(stale.isError, true)
  assert.match(resultText(stale), /会话已是第 2 轮/)
  const current = await call('get_review', { session_id: started.sessionId })
  assert.equal(current.review.comments[0].replies.at(-1).body, '已补充失败出口，请复核新版。')
  const resolved = await api(`${path}/mutations`, { round: current.round, expectedVersion: current.version,
    revision: current.review.revision, fingerprint: current.review.snapshot.fingerprint,
    mutations: [{ kind: 'set-status', commentId: comment.id, from: 'needs-review', status: 'resolved', reviewedRevision: current.review.revision }] })
  await api(`${path}/finish`, { expectedVersion: resolved.version, kind: 'approval' })
  const approved = await call('wait_review', { session_id: started.sessionId, after_submission: feedback.submission.id })
  assert.equal(approved.approved, true)
  assert.equal(approved.submission.kind, 'logic-margin-approval')
  assert.equal(approved.submission.review.resolvedCommentCount, 1)
  assert.equal('comments' in approved.submission.review, false)
  assert.equal('files' in approved.submission.review.snapshot, false)
  assert.equal(approved.submission.review.snapshot.fingerprint, next.snapshot.fingerprint)
  const retained = await call('get_review', { session_id: started.sessionId })
  assert.equal(retained.phase, 'approved')
  assert.equal(retained.history.at(-1).id, approved.submission.id)
  assert.equal(retained.history.at(-1).review.comments[0].body, comment.body)
  assert.equal(retained.history.at(-1).review.comments[0].replies.at(-1).body, '已补充失败出口，请复核新版。')
  assert.deepEqual(retained.history.at(-1).review.snapshot.files, next.snapshot.files)
  const record = await api(`${path}/records/${approved.submission.id}`)
  assert.deepEqual(record, retained.history.at(-1))
  assert.equal((await call('list_reviews', { state: 'archived' })).sessions.length, 0, 'Delivery must not archive before the Agent receives approval')
  const cleaned = await call('cleanup_review', { session_id: started.sessionId })
  assert.equal(cleaned.mode, 'archive')
  const archived = await call('get_review', { session_id: started.sessionId })
  assert.deepEqual(archived.history.at(-1), record)
  assert.equal((await call('list_reviews', { state: 'archived' })).sessions[0].id, started.sessionId)
  const restored = await call('restore_review', { session_id: started.sessionId })
  assert.equal(restored.sessionId, started.sessionId)
  assert.equal(restored.round, 2)
})

test('cancelling or timing out MCP wait preserves the pending review and later feedback', async t => {
  const { directory, reviewFile, client, call, api, source } = await setup(t)
  const review = await source()
  const started = await call('start_review', { review_file: reviewFile, source_root: directory, purpose: '核对取消恢复' })
  const controller = new AbortController()
  const waiting = client.callTool({ name: 'wait_review', arguments: { session_id: started.sessionId } }, undefined, { signal: controller.signal })
  await pause()
  controller.abort(new Error('user cancelled'))
  await assert.rejects(waiting, /cancelled/)
  const timedOut = await client.callTool({ name: 'wait_review', arguments: { session_id: started.sessionId, timeout_seconds: 0.03 } })
  assert.equal(timedOut.isError, true)
  assert.match(resultText(timedOut), /超时/)
  const before = await call('get_review', { session_id: started.sessionId })
  assert.equal(before.phase, 'awaiting-review')
  assert.equal(before.history.length, 0)
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '取消后仍保留本次意见。').comments.at(-1)!
  const saved = await api(`/${started.sessionId}/mutations`, { revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }] })
  const submitted = await api(`/${started.sessionId}/finish`, { expectedVersion: saved.version, kind: 'feedback' })
  const received = await call('wait_review', { session_id: started.sessionId })
  assert.equal(received.submission.id, submitted.history[0].id)
  assert.equal((await call('get_review', { session_id: started.sessionId })).acknowledgedSubmission, undefined)
})
