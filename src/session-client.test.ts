import test from 'node:test'
import assert from 'node:assert/strict'
import { addComment, addReply, setCommentStatus } from './model.ts'
import { sampleReview } from './sample.ts'
import { parsePendingSession, parseSession, reviewMutations } from './session-client.ts'
import type { ReviewSession } from './session-types.ts'

const review = () => ({ ...structuredClone(sampleReview), comments: [] })
const session = (): ReviewSession => ({ schemaVersion: 1, id: 'session-1', version: 1, round: 1, phase: 'awaiting-review',
  createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', review: review(), history: [], snapshots: [] })

test('session deltas preserve comment and reply identity for safe retries', () => {
  const before = review()
  const withComment = addComment(before, [{ kind: 'node', id: before.nodes[0].id }], '检查入口条件')
  assert.deepEqual(reviewMutations(before, withComment), [{ kind: 'add-comment', comment: withComment.comments[0] }])
  const withReply = addReply(withComment, withComment.comments[0].id, '补充边界条件')
  assert.deepEqual(reviewMutations(withComment, withReply), [{ kind: 'add-reply', commentId: withComment.comments[0].id, reply: withReply.comments[0].replies![0] }])
  assert.deepEqual(reviewMutations(withReply, withReply), [])
})

test('status deltas include prior status and reviewed source revision', () => {
  const before = addComment(review(), [{ kind: 'review', id: sampleReview.id }], '检查')
  const after = setCommentStatus(before, before.comments[0].id, 'resolved')
  assert.deepEqual(reviewMutations(before, after), [{ kind: 'set-status', commentId: before.comments[0].id,
    from: 'open', status: 'resolved', reviewedRevision: before.revision }])
})

test('a source replacement cannot be encoded as a comment save', () => {
  const before = review()
  assert.throws(() => reviewMutations(before, { ...before, revision: 'new-source' }), /发布新版/)
  assert.throws(() => reviewMutations(before, { ...before, snapshot: { ...before.snapshot, fingerprint: 'new-fingerprint' } }), /发布新版/)
})

test('durable queue restores the full optimistic view and exact mutation identities', () => {
  const before = review()
  const after = addComment(before, [{ kind: 'review', id: before.id }], '尚未发送的批注')
  const pending = { schemaVersion: 1, review: after, batches: [{ revision: before.revision,
    fingerprint: before.snapshot.fingerprint, mutations: reviewMutations(before, after) }] }
  assert.deepEqual(parsePendingSession(JSON.stringify(pending)), pending)
  assert.throws(() => parsePendingSession(JSON.stringify({ ...pending, batches: [{ ...pending.batches[0], mutations: [{ kind: 'unknown' }] }] })), /类型错误/)
  assert.throws(() => parsePendingSession('{broken'), SyntaxError)
})

test('session response validation rejects malformed history and snapshots', () => {
  const valid = session()
  valid.snapshots = [{ round: 1, openedAt: valid.createdAt, review: valid.review }]
  assert.deepEqual(parseSession(valid), valid)
  assert.throws(() => parseSession({ ...valid, version: 0 }), /格式错误/)
  assert.throws(() => parseSession({ ...valid, history: [{ kind: 'unknown' }] }))
  assert.throws(() => parseSession({ ...valid, snapshots: [{ ...valid.snapshots[0], openedAt: 'not a date' }] }), /快照格式/)
})
