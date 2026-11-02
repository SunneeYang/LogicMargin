import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore } from './session-store.ts'
import { sampleReview } from '../src/sample.ts'
import { addComment, addReply } from '../src/model.ts'
import type { ReviewSession } from '../src/session-types.ts'

async function setup(t: { after: (run: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionStore(directory)
  const review = structuredClone(sampleReview)
  review.comments = []
  const session = await store.create(review)
  return { store, directory, session }
}
function commentBatch(state: ReviewSession, body = '此校验是否应在扣费之前？') {
  const next = addComment(state.review, [{ kind: 'node', id: state.review.nodes[0].id }], body)
  return { revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment: next.comments.at(-1)! }] }
}
function statusBatch(state: ReviewSession, status: 'open' | 'resolved' | 'needs-review') {
  return { revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint, expectedVersion: state.version,
    mutations: [{ kind: 'set-status', commentId: state.review.comments[0].id, from: state.review.comments[0].status, status, reviewedRevision: state.review.revision }] }
}
function replyBatch(state: ReviewSession, body = '已调整校验顺序') {
  const next = addReply(state.review, state.review.comments[0].id, body, 'agent')
  return { revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-reply', commentId: state.review.comments[0].id, reply: next.comments[0].replies!.at(-1)! }] }
}

test('saving is separate from Finish; submissions, acknowledgement and opinions survive restart', async t => {
  const { store, directory, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  assert.equal(saved.phase, 'awaiting-review')
  assert.equal(saved.history.length, 0)
  const submitted = await store.finish(session.id, { expectedVersion: saved.version, kind: 'feedback', submissionId: 'finish-1' })
  assert.equal(submitted.phase, 'feedback-ready')
  assert.equal(submitted.history[0].review.comments.length, 1)
  const acknowledged = await store.acknowledge(session.id, { submissionId: 'finish-1' })
  assert.equal(acknowledged.phase, 'agent-working')
  assert.deepEqual(await store.acknowledge(session.id, { submissionId: 'finish-1' }), acknowledged)
  assert.deepEqual(await new SessionStore(directory).get(session.id), acknowledged)
  assert.deepEqual(await store.finish(session.id, { expectedVersion: saved.version, kind: 'feedback', submissionId: 'finish-1' }), acknowledged)
})

test('concurrent appends merge, retry does not duplicate, conflicts and batches are atomic', async t => {
  const { store, session } = await setup(t)
  const first = commentBatch(session, '第一条')
  const second = commentBatch(session, '第二条')
  await Promise.all([store.mutate(session.id, first), store.mutate(session.id, second)])
  const merged = await store.get(session.id)
  assert.equal(merged.review.comments.length, 2)
  assert.deepEqual(await store.mutate(session.id, first), merged)
  const conflict = structuredClone(first)
  conflict.mutations[0].comment.body = '篡改相同标识'
  await assert.rejects(store.mutate(session.id, conflict), /冲突/)
  const atomic = commentBatch(merged, '不应留下部分批次')
  await assert.rejects(store.mutate(session.id, { ...atomic, mutations: [...atomic.mutations, { kind: 'unknown' }] }), /不支持/)
  assert.deepEqual(await store.get(session.id), merged)
})

test('agent replies require human recheck; unseen replies prevent stale resolution and approval', async t => {
  const { store, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const firstReply = await store.mutate(session.id, replyBatch(saved))
  assert.equal(firstReply.review.comments[0].status, 'needs-review')
  const attemptedResolution = statusBatch(firstReply, 'resolved')
  const secondReply = await store.mutate(session.id, replyBatch(firstReply, '补充说明'))
  await assert.rejects(store.mutate(session.id, attemptedResolution), /最新回复/)
  await assert.rejects(store.finish(session.id, { kind: 'approval', expectedVersion: firstReply.version }), /已有更新/)
  await assert.rejects(store.finish(session.id, { kind: 'approval', expectedVersion: secondReply.version }), /不能确认/)
  const resolved = await store.mutate(session.id, statusBatch(secondReply, 'resolved'))
  const approved = await store.finish(session.id, { kind: 'approval', expectedVersion: resolved.version })
  assert.equal(approved.phase, 'approved')
  const restored = await store.mutate(session.id, statusBatch(approved, 'open'))
  assert.equal(restored.phase, 'awaiting-review')
  assert.equal(restored.review.comments[0].replies?.length, 2)
})

test('publishing a new round preserves all opinions and immutable submissions', async t => {
  const { store, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const finished = await store.finish(session.id, { kind: 'feedback', expectedVersion: saved.version })
  const before = structuredClone(finished.history)
  const incoming = structuredClone(session.review)
  incoming.revision = 'revision-two'
  incoming.snapshot.fingerprint = 'fingerprint-two'
  const next = await store.revise(session.id, { expectedVersion: finished.version, review: incoming })
  assert.equal(next.round, 2)
  assert.equal(next.phase, 'awaiting-review')
  assert.equal(next.snapshots.length, 2)
  assert.equal(next.review.comments[0].status, 'needs-review')
  assert.equal(next.review.comments[0].revision, session.review.revision)
  assert.deepEqual(next.history, before)
  await assert.rejects(store.acknowledge(session.id, { submissionId: finished.history[0].id }), /已结束的轮次/)
  await assert.rejects(store.mutate(session.id, commentBatch(session)), /流程已更新/)
  const foreign = structuredClone(incoming); foreign.id = 'other-document'
  await assert.rejects(store.revise(session.id, { expectedVersion: next.version, review: foreign }), /相同评审/)
})

test('Finish packages only new human feedback, and does not resubmit unchanged open opinions', async t => {
  const { store, session } = await setup(t)
  const first = await store.mutate(session.id, commentBatch(session, '第一条意见'))
  const submitted = await store.finish(session.id, { kind: 'feedback', expectedVersion: first.version })
  await assert.rejects(store.finish(session.id, { kind: 'feedback', expectedVersion: submitted.version }), /没有新的/)
  const second = await store.mutate(session.id, commentBatch(submitted, '第二条意见'))
  const next = await store.finish(session.id, { kind: 'feedback', expectedVersion: second.version })
  assert.equal(next.review.comments.length, 2)
  assert.deepEqual(next.history[1].review.comments.map(item => item.body), ['第二条意见'])
  assert.deepEqual(next.history[0], submitted.history[0])
})

test('corrupted store fails without replacing original; invalid ids cannot traverse directories', async t => {
  const { store, directory, session } = await setup(t)
  const path = join(directory, `${session.id}.json`)
  await writeFile(path, '{ damaged')
  await assert.rejects(store.get(session.id), /原文件已保留/)
  await assert.rejects(store.mutate(session.id, commentBatch(session)), /原文件已保留/)
  assert.equal(await readFile(path, 'utf8'), '{ damaged')
  await assert.rejects(store.get('../secret'), /标识无效/)
})

test('long polling observes actual versions and handles timeout and abort', async t => {
  const { store, session } = await setup(t)
  assert.equal(await store.waitForChange(session.id, session.version, 5), null)
  const waiting = store.waitForChange(session.id, session.version, 1000)
  const saved = await store.mutate(session.id, commentBatch(session))
  assert.deepEqual(await waiting, saved)
  const controller = new AbortController()
  const aborted = store.waitForChange(session.id, saved.version, 1000, controller.signal)
  controller.abort()
  assert.equal(await aborted, null)
})
