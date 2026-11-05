import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addComment, addReply, setCommentStatus } from './model.ts'
import { createApprovalRecord, createFeedbackPackage, draftKey, makeDraft, parseDrafts, parseRecordHistory, parseReviewRecord, pendingFeedback, withDraft } from './workspace.ts'
import type { ReviewDocument } from './types.ts'

function fixture(): ReviewDocument {
  return {
    schemaVersion: 1, id: 'review', title: '升级流程', description: '源自代码', revision: 'v1',
    snapshot: { repository: '/vast', commit: 'abc', fingerprint: 'hash1', capturedAt: '2026-11-02T00:00:00Z', dirty: true },
    coverage: { included: ['升级'], excluded: ['重置'], note: '范围说明' },
    scenes: [{ id: 'level', title: '升级', description: '' }],
    nodes: [{ id: 'check', sceneId: 'level', title: '检查条件', kind: 'action', summary: '', detail: '', input: '', output: '',
      position: { x: 0, y: 0 }, evidence: [{ path: 'skill.go', symbol: 'LevelUp', startLine: 1, endLine: 10, digest: 'abc' }] }],
    edges: [], comments: [],
  }
}

test('draft identities include snapshot, canonical target set and reply thread', () => {
  const review = fixture()
  const selected = [{ kind: 'node', id: 'check' }, { kind: 'scene', id: 'level' }] as const
  assert.equal(draftKey(review, [...selected]), draftKey(review, [...selected].reverse()))
  for (const next of [{ ...review, revision: 'v2' }, { ...review, id: 'other' },
    { ...review, snapshot: { ...review.snapshot, fingerprint: 'other' } }]) {
    assert.notEqual(draftKey(review, [...selected]), draftKey(next, [...selected]))
  }
  assert.notEqual(draftKey(review, [...selected]), draftKey(review, [...selected], 'thread'))
  const draft = makeDraft(review, [...selected], ' 尚未提交 ')
  assert.equal(draft.body, ' 尚未提交 ')
  assert.deepEqual(draft.labels, ['检查条件', '场景 · 升级'])
  assert.deepEqual(parseDrafts(JSON.parse(JSON.stringify([draft]))), [draft])
})

test('baseline drafts use original labels and a separate key while replies retain their original basis', () => {
  const baseline = fixture()
  const current = fixture()
  current.baseline = baseline
  current.nodes[0].title = '当前改造后的检查'
  const selected = [{ kind: 'node' as const, id: 'check' }]
  const oldKey = JSON.stringify([current.id, current.revision, current.snapshot.fingerprint, [['node', 'check']], null])
  assert.equal(draftKey(current, selected), oldKey)
  const draft = makeDraft(current, selected, '请改造原系统', undefined, 'baseline')
  assert.equal(draft.basis, 'baseline')
  assert.notEqual(draft.key, oldKey)
  assert.deepEqual(draft.labels, ['检查条件'])
  assert.equal(draft.revision, current.revision)
  assert.equal(draft.fingerprint, current.snapshot.fingerprint)
  assert.deepEqual(parseDrafts([draft]), [draft])
  assert.throws(() => parseDrafts([{ ...draft, basis: undefined }]), /草稿标识/)
  const annotated = addComment(current, selected, '第一条改造要求', 'baseline')
  const reply = makeDraft(annotated, selected, '补充要求', annotated.comments[0].id)
  assert.equal(reply.basis, 'baseline')
  assert.equal(reply.key, draftKey(annotated, selected, annotated.comments[0].id))
  const ordinary = addComment(current, selected, '当前图意见')
  assert.throws(() => makeDraft(ordinary, selected, '伪装来源', ordinary.comments[0].id, 'baseline'), /不能改变原批注依据/)
})

test('draft updates preserve other versions and orphan drafts and only delete the exact empty draft', () => {
  const review = fixture()
  const old = makeDraft({ ...review, revision: 'old' }, [{ kind: 'node', id: 'removed' }], '保留旧稿')
  const current = makeDraft(review, [{ kind: 'node', id: 'check' }], '新稿')
  const initial = [old]
  const both = withDraft(initial, current)
  assert.deepEqual(initial, [old])
  assert.deepEqual(both, [old, current])
  const replaced = withDraft(both, { ...current, body: '修订' })
  assert.deepEqual(replaced.map(draft => draft.body), ['保留旧稿', '修订'])
  assert.deepEqual(withDraft(replaced, { ...current, body: '' }), [old])
  assert.equal(withDraft([current], { ...current, body: ' ' }).length, 1)
  assert.deepEqual(parseDrafts([old]), [old])
})

test('draft parsing rejects malformed, mismatched and oversized text without silent truncation', () => {
  const review = fixture()
  const draft = makeDraft(review, [{ kind: 'node', id: 'check' }], '草稿')
  for (const value of [null, {}, [{ ...draft, body: 1 }], [{ ...draft, body: 'a'.repeat(10001) }],
    [{ ...draft, updatedAt: 'bad' }], [{ ...draft, targets: [] }], [{ ...draft, key: 'wrong' }],
    [{ ...draft, labels: [] }], [{ ...draft, replyTo: '' }], [draft, draft]]) {
    assert.throws(() => parseDrafts(value))
  }
})

test('draft and anchor collections can grow past previous limits and retain other drafts', () => {
  const review = fixture()
  const selected = Array.from({ length: 501 }, (_, index) => ({ kind: 'node' as const, id: `${index}` }))
  const draft = makeDraft(review, selected, '草稿')
  assert.equal(parseDrafts([draft])[0].targets.length, 501)
  const full = Array.from({ length: 201 }, (_, index) => makeDraft(review, [{ kind: 'node', id: `${index}` }], '草稿'))
  assert.equal(parseDrafts([...full, draft]).length, 202)
  assert.deepEqual(withDraft(full, draft), [...full, draft])
  assert.equal(full.length, 201)
})

test('feedback packages capture only open comments and clone all review context', () => {
  let review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '待处理')
  review = addReply(review, review.comments[0].id, '补充')
  review = addComment(review, [{ kind: 'scene', id: 'level' }], '已解决')
  review = setCommentStatus(review, review.comments[1].id, 'resolved')
  const feedback = createFeedbackPackage(review)
  assert.equal(feedback.kind, 'logic-margin-feedback')
  assert.equal(feedback.review.comments.length, 1)
  assert.deepEqual(feedback.review.snapshot, review.snapshot)
  assert.deepEqual(feedback.review.coverage, review.coverage)
  assert.deepEqual(parseReviewRecord(JSON.parse(JSON.stringify(feedback))), feedback)
  review.nodes[0].evidence[0].digest = 'changed'
  review.coverage.included.push('更多')
  review.comments[0].replies![0].body = '改写本地'
  review.comments[0].targets[0].id = 'different'
  assert.equal(feedback.review.nodes[0].evidence[0].digest, 'abc')
  assert.deepEqual(feedback.review.coverage.included, ['升级'])
  assert.equal(feedback.review.comments[0].replies?.[0].body, '补充')
  assert.equal(feedback.review.comments[0].targets[0].id, 'check')
  assert.throws(() => createFeedbackPackage(fixture()), /没有/)
})

test('approval records require explicit resolution of every issue and allow an empty review', () => {
  const empty = createApprovalRecord(fixture())
  assert.equal(empty.kind, 'logic-margin-approval')
  assert.deepEqual(parseReviewRecord(empty), empty)
  const review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '问题')
  assert.throws(() => createApprovalRecord(review), /不能确认通过/)
  const needsReview = setCommentStatus(review, review.comments[0].id, 'needs-review')
  assert.throws(() => createApprovalRecord(needsReview), /不能确认通过/)
  const resolved = setCommentStatus(review, review.comments[0].id, 'resolved')
  assert.equal(createApprovalRecord(resolved).review.comments[0].status, 'resolved')
  assert.throws(() => parseReviewRecord({ ...empty, review }), /未解决/)
})

test('record parsing validates envelopes and contained review states without limiting history count', () => {
  const review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '问题')
  const feedback = createFeedbackPackage(review)
  for (const value of [null, {}, { ...feedback, schemaVersion: 2 }, { ...feedback, kind: 'delivered' },
    { ...feedback, createdAt: 'invalid' }, { ...feedback, id: '' }, { ...feedback, review: fixture() },
    { ...feedback, review: setCommentStatus(review, review.comments[0].id, 'needs-review') }]) {
    assert.throws(() => parseReviewRecord(value))
  }
  assert.deepEqual(parseRecordHistory([feedback]), [feedback])
  assert.throws(() => parseRecordHistory([feedback, { ...feedback, createdAt: '2026-11-02T01:00:00Z' }]), /冲突/)
  assert.equal(parseRecordHistory(Array.from({ length: 51 }, (_, index) => ({ ...feedback, id: `${index}` }))).length, 51)
})

test('reimporting a growing fixed history is idempotent and conflicting records still fail', () => {
  const feedback = createFeedbackPackage(addComment(fixture(), [{ kind: 'node', id: 'check' }], '问题'))
  assert.deepEqual(parseRecordHistory([feedback, JSON.parse(JSON.stringify(feedback))]), [feedback])
  const full = Array.from({ length: 60 }, (_, index) => ({ ...feedback, id: `${index}` }))
  assert.deepEqual(parseRecordHistory([...full, full[0], full[59]]), full)
  assert.throws(() => parseRecordHistory([...full, { ...full[0], createdAt: '2026-11-02T01:00:00Z' }]), /冲突/)
  assert.equal(full.length, 60)
})

test('large feedback and approval records retain the complete result across serialization', () => {
  const base = addComment(fixture(), [{ kind: 'node', id: 'check' }], 'a'.repeat(10000))
  const review = { ...base, comments: Array.from({ length: 1100 }, (_, index) => ({ ...base.comments[0], id: `${index}` })) }
  const feedback = createFeedbackPackage(review)
  const serialized = JSON.stringify(feedback)
  assert.ok(new TextEncoder().encode(serialized).byteLength > 10 * 1024 * 1024)
  assert.equal(parseReviewRecord(JSON.parse(serialized)).review.comments.length, 1100)
  const resolved = { ...review, comments: review.comments.map(comment => ({ ...comment, status: 'resolved' as const })) }
  assert.equal(parseReviewRecord(createApprovalRecord(resolved)).review.comments.length, 1100)
})

test('pending feedback compares the latest matching human content at the source snapshot', () => {
  let review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '问题')
  const commentId = review.comments[0].id
  assert.deepEqual(pendingFeedback(review, []), review.comments)
  const submitted = createFeedbackPackage(review)
  assert.deepEqual(pendingFeedback(review, [submitted]), [])
  const agentOnly = setCommentStatus(addReply(review, commentId, '代理回应', 'agent'), commentId, 'open')
  assert.deepEqual(pendingFeedback(agentOnly, [submitted]), [])
  review = addReply(agentOnly, commentId, '人工补充')
  assert.deepEqual(pendingFeedback(review, [submitted]), review.comments)
  const second = { ...createFeedbackPackage(review), createdAt: new Date(Date.parse(submitted.createdAt) + 1000).toISOString() }
  assert.deepEqual(pendingFeedback(review, [second, submitted]), [])
  const differentSnapshot = { ...review, snapshot: { ...review.snapshot, fingerprint: 'changed' } }
  assert.deepEqual(pendingFeedback(differentSnapshot, [second]), review.comments)
  const differentVersion = { ...review, revision: 'v2' }
  assert.deepEqual(pendingFeedback(differentVersion, [second]), review.comments)
  const needsReview = setCommentStatus(review, commentId, 'needs-review')
  assert.deepEqual(pendingFeedback(needsReview, []), [])
  const resolved = setCommentStatus(review, commentId, 'resolved')
  const approval = createApprovalRecord(resolved)
  assert.deepEqual(pendingFeedback(review, [approval]), review.comments)
  assert.deepEqual(pendingFeedback(review, [{ ...second, review: { ...second.review, id: 'another' } }]), review.comments)
})

test('unchanged target reordering is not new feedback but a new human reply or original opinion is', () => {
  const review = addComment(fixture(), [{ kind: 'node', id: 'check' }, { kind: 'scene', id: 'level' }], '意见')
  const feedback = createFeedbackPackage(review)
  const reordered = structuredClone(review)
  reordered.comments[0].targets.reverse()
  assert.deepEqual(pendingFeedback(reordered, [feedback]), [])
  reordered.comments[0].body = '修订意见'
  assert.deepEqual(pendingFeedback(reordered, [feedback]), reordered.comments)
})

test('latest submitted content is indexed per thread and equal timestamps keep later record precedence', () => {
  const one = addComment(fixture(), [{ kind: 'node', id: 'check' }], '第一条')
  const first = createFeedbackPackage(one)
  const updated = addReply(one, one.comments[0].id, '新的人类说明')
  const sameTime = { ...createFeedbackPackage(updated), createdAt: first.createdAt }
  const two = addComment(updated, [{ kind: 'scene', id: 'level' }], '第二条')
  assert.deepEqual(pendingFeedback(two, [first, sameTime]).map(comment => comment.body), ['第二条'])
  assert.deepEqual(pendingFeedback(two, [sameTime, first]).map(comment => comment.body), ['第一条', '第二条'])
})
