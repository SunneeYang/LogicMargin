import test from 'node:test'
import assert from 'node:assert/strict'
import { addComment, addReply, setCommentStatus } from './model.ts'
import { sampleReview } from './sample.ts'
import { currentPendingFeedback, parseCurrentSession, parsePendingSession, parseSession, pendingMatchesSession, reviewMutations, sameVisibleReview } from './session-client.ts'
import type { CurrentSession, ReviewSession } from './session-types.ts'

const review = () => ({ ...structuredClone(sampleReview), comments: [] })
const session = (): ReviewSession => ({ schemaVersion: 1, id: 'session-1', version: 1, round: 1, phase: 'awaiting-review',
  createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', review: review(), history: [], snapshots: [] })

const currentSession = (): CurrentSession => ({ ...session(), view: 'current', submittedCommentIds: [], commentOrigins: [],
  snapshots: [{ round: 1, openedAt: '2026-11-03T00:00:00Z' }], history: [] })

test('current session validates catalogs without fabricating historical documents', () => {
  const current = currentSession()
  assert.deepEqual(parseCurrentSession(current), current)
  assert.throws(() => parseCurrentSession({ ...current, view: undefined }), /格式错误/)
  assert.throws(() => parseCurrentSession({ ...current, snapshots: [] }), /格式错误/)
  assert.throws(() => parseCurrentSession({ ...current, submittedCommentIds: ['missing'] }), /目录错误/)
  assert.throws(() => parseCurrentSession({ ...current, commentOrigins: [{ commentId: 'missing', round: 2, exact: true }] }), /目录错误/)
  assert.equal('review' in current.snapshots[0], false)
})

test('compact feedback preserves submission identity while optimistic human changes become pending', () => {
  const remote = currentSession()
  remote.review = addComment(remote.review, [{ kind: 'review', id: remote.review.id }], '已提交的意见')
  remote.submittedCommentIds = [remote.review.comments[0].id]
  assert.deepEqual(currentPendingFeedback(remote.review, remote), [])
  const supplement = addReply(remote.review, remote.review.comments[0].id, '新的人工补充')
  assert.equal(currentPendingFeedback(supplement, remote).length, 1)
  const agent = addReply(remote.review, remote.review.comments[0].id, '交流回应', 'agent')
  agent.comments[0].status = 'open'
  assert.equal(currentPendingFeedback(agent, remote).length, 0)
  const newComment = addComment(remote.review, [{ kind: 'review', id: remote.review.id }], '新意见')
  assert.equal(currentPendingFeedback(newComment, remote)[0].body, '新意见')
})

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

test('Finish accepts server round stamps but still detects unseen replies, logic and status changes', () => {
  const commented = addComment(review(), [{ kind: 'review', id: sampleReview.id }], '检查')
  const before = addReply(commented, commented.comments[0].id, '补充')
  const after = structuredClone(before)
  after.comments[0].originRound = 1
  after.comments[0].reviewedRound = 1
  after.comments[0].replies![0].round = 1
  assert.equal(sameVisibleReview(before, after), true)
  assert.equal(before.comments[0].originRound, undefined)
  after.comments[0].replies![0].body = '尚未看到的修改'
  assert.equal(sameVisibleReview(before, after), false)
  after.comments[0].replies![0].body = before.comments[0].replies![0].body
  after.comments[0].status = 'resolved'
  assert.equal(sameVisibleReview(before, after), false)
  after.comments[0].status = before.comments[0].status
  after.nodes[0].detail = '尚未看到的规则变化'
  assert.equal(sameVisibleReview(before, after), false)
})

test('offline queues cannot be overlaid or replayed across identical source rounds', () => {
  const current = session()
  const pending = { schemaVersion: 1 as const, review: current.review, batches: [{ revision: current.review.revision,
    fingerprint: current.review.snapshot.fingerprint, round: 1, mutations: [] }] }
  assert.equal(pendingMatchesSession(pending, current), true)
  current.round = 2
  assert.equal(pendingMatchesSession(pending, current), false)
  const legacy = { ...pending, batches: pending.batches.map(({ round: _round, ...batch }) => batch) }
  assert.equal(pendingMatchesSession(legacy, current), false)
  current.round = 1
  assert.equal(pendingMatchesSession(legacy, current), true)
  assert.equal(pendingMatchesSession({ ...pending, review: { ...pending.review, revision: 'other-source' } }, current), false)
})
