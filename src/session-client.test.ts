import test from 'node:test'
import assert from 'node:assert/strict'
import { addComment, addReply, setCommentStatus } from './model.ts'
import { sampleReview } from './sample.ts'
import { baselineRequest, cleanupSession, currentPendingFeedback, currentRequest, listSessions, parseCurrentSession, parsePendingSession, parseSession, parseSessionSummary, pendingMatchesSession, reviewMutations, sameVisibleReview, SessionRequestError } from './session-client.ts'
import type { CurrentSession, ReviewSession } from './session-types.ts'

const review = () => ({ ...structuredClone(sampleReview), comments: [] })
const session = (): ReviewSession => ({ schemaVersion: 1, id: 'session-1', version: 1, round: 1, phase: 'awaiting-review',
  createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', review: review(), history: [], snapshots: [] })

const currentSession = (): CurrentSession => ({ ...session(), view: 'current', submittedCommentIds: [], commentOrigins: [],
  snapshots: [{ round: 1, openedAt: '2026-11-03T00:00:00Z' }], history: [] })

test('session views preserve independent purpose and cleanup policy beyond fifty rounds', () => {
  const full = session()
  full.scope = { context: 'same-agent-thread', purpose: '只检查成功后的票券扣除' }
  full.cleanupPolicy = 'archive-on-approval'
  full.round = 51
  full.snapshots = Array.from({ length: full.round }, (_, index) => ({ round: index + 1, openedAt: full.createdAt, review: full.review }))
  assert.deepEqual(parseSession(full), full)
  const current = { ...full, view: 'current' as const, submittedCommentIds: [], commentOrigins: [],
    snapshots: full.snapshots.map(({ review: _review, ...item }) => item) }
  assert.deepEqual(parseCurrentSession(current), current)
  assert.throws(() => parseCurrentSession({ ...current, scope: { purpose: ' ' } }), /目的/)
})

test('summary validation keeps archived task identity and rejects malformed lifecycle data', () => {
  const current = session()
  const summary = { id: current.id, title: current.review.title, phase: current.phase, version: 3, round: 70,
    createdAt: current.createdAt, updatedAt: current.updatedAt, archivedAt: current.updatedAt,
    scope: { context: 'thread-1', purpose: '单独检查边界条件' }, cleanupPolicy: 'manual' as const }
  assert.deepEqual(parseSessionSummary(summary), summary)
  assert.throws(() => parseSessionSummary({ ...summary, archivedAt: 'invalid' }), /列表格式/)
  assert.throws(() => parseSessionSummary({ ...summary, cleanupPolicy: 'delete-everything' }), /清理策略/)
})

test('removed sessions expose terminal HTTP status while cleanup sends the reviewed version', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/cleanup')) {
      assert.equal(options?.method, 'POST')
      assert.deepEqual(JSON.parse(String(options?.body)), { expectedVersion: 8, mode: 'archive' })
      return Response.json({ id: 'session-1', mode: 'archive', archivedAt: '2026-11-03T00:00:00Z' })
    }
    return Response.json({ error: '评审任务已归档' }, { status: 410 })
  })
  await assert.rejects(currentRequest('/session-1'), error => error instanceof SessionRequestError && error.status === 410)
  assert.equal((await cleanupSession('session-1', 8, 'archive')).id, 'session-1')
})

test('task list keeps healthy reviews available while reporting unreadable items', async t => {
  const current = session()
  const summary = { id: current.id, title: current.review.title, phase: current.phase, version: current.version, round: current.round,
    createdAt: current.createdAt, updatedAt: current.updatedAt }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sessions: [summary], warnings: ['损坏任务已保留'] }))
  let warning = ''
  assert.deepEqual(await listSessions(undefined, message => { warning = message }), [summary])
  assert.equal(warning, '损坏任务已保留')
})

test('current session validates catalogs without fabricating historical documents', () => {
  const current = currentSession()
  assert.deepEqual(parseCurrentSession(current), current)
  assert.throws(() => parseCurrentSession({ ...current, view: undefined }), /格式错误/)
  assert.throws(() => parseCurrentSession({ ...current, snapshots: [] }), /格式错误/)
  assert.throws(() => parseCurrentSession({ ...current, submittedCommentIds: ['missing'] }), /目录错误/)
  assert.throws(() => parseCurrentSession({ ...current, commentOrigins: [{ commentId: 'missing', round: 2, exact: true }] }), /目录错误/)
  assert.equal('review' in current.snapshots[0], false)
})

test('current, full and pending sessions preserve prior human resolutions after a new source revision', () => {
  const annotated = addComment(review(), [{ kind: 'node', id: sampleReview.nodes[0].id }], '已确认的意见')
  const confirmed = setCommentStatus(annotated, annotated.comments[0].id, 'resolved')
  confirmed.comments[0].reviewedRound = 1
  const next = { ...confirmed, revision: 'new-revision', snapshot: { ...confirmed.snapshot, fingerprint: 'new-fingerprint' } }
  const current = currentSession()
  current.round = 2
  current.review = next
  current.snapshots.push({ round: 2, openedAt: current.updatedAt })
  current.commentOrigins = [{ commentId: confirmed.comments[0].id, round: 1, exact: true }]
  assert.deepEqual(parseCurrentSession(JSON.parse(JSON.stringify(current))), current)
  const full = { ...session(), round: 2, review: next, snapshots: [
    { round: 1, openedAt: current.createdAt, review: confirmed },
    { round: 2, openedAt: current.updatedAt, review: next },
  ] }
  assert.deepEqual(parseSession(JSON.parse(JSON.stringify(full))), full)
  assert.equal(sameVisibleReview(next, parseCurrentSession(current).review), true)
  const supplement = addReply(next, confirmed.comments[0].id, '新的人工作补充')
  const pending = { schemaVersion: 1, review: supplement, batches: [{ round: 2, expectedVersion: 4,
    revision: next.revision, fingerprint: next.snapshot.fingerprint, mutations: reviewMutations(next, supplement) }] }
  assert.deepEqual(parsePendingSession(JSON.stringify(pending)), pending)
  assert.deepEqual(next.comments, confirmed.comments)
})

test('current baseline summaries validate identity metadata while full baseline documents load on demand', async t => {
  const current = currentSession()
  const baseline = { ...review(), revision: 'baseline-code' }
  const { files: _files, ...snapshot } = baseline.snapshot
  current.baseline = { revision: baseline.revision, snapshot }
  assert.deepEqual(parseCurrentSession(current), current)
  assert.throws(() => parseCurrentSession({ ...current, baseline: { ...current.baseline, snapshot: { ...snapshot, capturedAt: 'invalid' } } }), /固定基线摘要/)
  assert.throws(() => parseCurrentSession({ ...current, baseline: { revision: '', snapshot } }), /固定基线摘要/)
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/review-sessions/session-1/baseline')
    return Response.json({ review: baseline })
  })
  assert.deepEqual(await baselineRequest('session-1'), baseline)
})

test('compact baseline comments defer only target lookup and preserve source identity through pending queues', () => {
  const full = review()
  full.baseline = review()
  const target = { kind: 'node' as const, id: full.nodes[0].id }
  full.nodes = full.nodes.slice(1)
  full.edges = full.edges.filter(edge => edge.source !== target.id && edge.target !== target.id)
  const annotated = addComment(full, [target], '修改基线中的这一步', 'baseline')
  const { baseline, ...compact } = annotated
  const current = currentSession()
  current.review = compact
  const { files: _files, ...snapshot } = baseline!.snapshot
  current.baseline = { revision: baseline!.revision, snapshot }
  const parsed = parseCurrentSession(current)
  assert.equal(parsed.review.comments[0].basis, 'baseline')
  assert.equal(parsed.review.comments[0].status, 'open')
  assert.equal(sameVisibleReview(annotated, parsed.review), true)
  const pending = { schemaVersion: 1, review: compact, batches: [{ revision: compact.revision, fingerprint: compact.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment: compact.comments[0] }] }] }
  assert.equal(parsePendingSession(JSON.stringify(pending)).review.comments[0].basis, 'baseline')
  assert.throws(() => reviewMutations(annotated, { ...annotated, comments: [{ ...annotated.comments[0], basis: undefined }] }), /依据不能修改/)
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

test('discussion body edits become guarded mutations and survive durable recovery', () => {
  const commented = addComment(review(), [{ kind: 'review', id: sampleReview.id }], '原意见')
  const before = addReply(commented, commented.comments[0].id, '原补充')
  const after = structuredClone(before)
  after.comments[0].body = '修改后的意见'
  after.comments[0].replies![0].body = '修改后的补充'
  const mutations = reviewMutations(before, after)
  assert.deepEqual(mutations, [
    { kind: 'edit-comment', commentId: before.comments[0].id, from: '原意见', body: '修改后的意见' },
    { kind: 'edit-reply', commentId: before.comments[0].id, replyId: before.comments[0].replies![0].id, from: '原补充', body: '修改后的补充' },
  ])
  const pending = { schemaVersion: 1, review: after, batches: [{ round: 1, expectedVersion: 3,
    revision: before.revision, fingerprint: before.snapshot.fingerprint, mutations }] }
  assert.deepEqual(parsePendingSession(JSON.stringify(pending)), pending)
  assert.throws(() => parsePendingSession(JSON.stringify({ ...pending, batches: [{ ...pending.batches[0],
    mutations: [{ ...mutations[0], from: null }] }] })), /修改/)
})

test('current sessions preserve scoped edit permissions and remain compatible with older services', () => {
  const current = currentSession()
  const comment = addComment(current.review, [{ kind: 'review', id: current.review.id }], '可修改')
  current.review = addReply(comment, comment.comments[0].id, '可修改补充')
  const c = current.review.comments[0]
  current.editableDiscussion = { comments: [c.id], replies: [{ commentId: c.id, replyId: c.replies![0].id }] }
  assert.deepEqual(parseCurrentSession(current), current)
  assert.throws(() => parseCurrentSession({ ...current, editableDiscussion: { comments: [], replies: [{ commentId: 'missing', replyId: c.replies![0].id }] } }), /编辑权限/)
  assert.throws(() => parseCurrentSession({ ...current, editableDiscussion: { comments: [c.id, c.id], replies: [] } }), /编辑权限/)
  delete current.editableDiscussion
  assert.deepEqual(parseCurrentSession(current), current)
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
