import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleReview } from './sample.ts'
import { addComment, addReply } from './model.ts'
import { commentOrigin, comparisonSnapshot, getRevisionChanges, graphVersionLabel, logicIdentity, parsePublication, reviewAtRound } from './revisions.ts'
import type { ReviewSession } from './session-types.ts'

test('semantic changes, evidence updates and layout changes are distinct', () => {
  const before = structuredClone(sampleReview)
  const layout = structuredClone(before)
  layout.nodes[0].position.y += 200
  layout.nodes[0].evidence[0].code = 'newly captured source text'
  assert.equal(logicIdentity(layout), logicIdentity(before))
  assert.deepEqual(getRevisionChanges(before, layout), { added: [], changed: [], removed: [], evidenceChanged: [], metadataChanged: false })
  layout.nodes[0].evidence[0].digest = 'new-evidence'
  assert.deepEqual(getRevisionChanges(before, layout).evidenceChanged, [{ kind: 'node', id: layout.nodes[0].id }])
  assert.deepEqual(getRevisionChanges(before, layout).changed, [])
  layout.nodes[0].output += ' 新的状态变化'
  assert.deepEqual(getRevisionChanges(before, layout).changed, [{ kind: 'node', id: layout.nodes[0].id }])
  assert.notEqual(logicIdentity(layout), logicIdentity(before))
})

test('baseline-first graph labels and baseline comment origins remain independent from review rounds', () => {
  assert.equal(graphVersionLabel({}, 1), 'R1')
  assert.equal(graphVersionLabel({ baselineReview: true }, 1), '基线 B')
  assert.equal(graphVersionLabel({ baselineReview: true }, 2), 'R1')
  assert.equal(graphVersionLabel({ baselineReview: true }, 3), 'R2')
  const baseline = { ...structuredClone(sampleReview), comments: [] }
  const review = addComment({ ...structuredClone(baseline), baseline }, [{ kind: 'node', id: baseline.nodes[0].id }], '原版改造意见', 'baseline')
  review.comments[0].originRound = 1
  const session: ReviewSession = { schemaVersion: 1, id: 'baseline-test', baselineReview: true, round: 2, version: 3, phase: 'awaiting-review',
    createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', review, history: [],
    snapshots: [{ round: 1, openedAt: '2026-11-03T00:00:00Z', review: baseline }, { round: 2, openedAt: '2026-11-03T00:00:00Z', review }] }
  assert.equal(commentOrigin(session, review.comments[0]), undefined)
  assert.equal(reviewAtRound(session, 1).comments[0].basis, 'baseline')
})

test('historical graph projects later-created original comments and current replies without adding future opinions', () => {
  const first = structuredClone(sampleReview)
  const commented = addComment(first, [{ kind: 'node', id: first.nodes[0].id }], '删除后仍需看原位置')
  commented.comments[0].originRound = 1
  let current = addReply(commented, commented.comments[0].id, '已删除旧步骤，移到新版结算', 'agent')
  current = addComment(current, [{ kind: 'review', id: current.id }], '只属于第二轮的新意见')
  current.comments[1].originRound = 2
  current.revision = 'new'
  current.nodes = current.nodes.slice(1)
  current.edges = current.edges.filter(edge => edge.source !== first.nodes[0].id && edge.target !== first.nodes[0].id)
  const session: ReviewSession = { schemaVersion: 1, id: 'test', round: 2, version: 5, phase: 'awaiting-review', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', review: current, history: [], snapshots: [
    { round: 1, openedAt: '2026-11-03T00:00:00Z', review: first }, { round: 2, openedAt: '2026-11-03T00:01:00Z', review: structuredClone(current) },
  ] }
  assert.equal(session.snapshots[0].review.comments.length, 0)
  const historical = reviewAtRound(session, 1)
  assert.equal(historical.comments.length, 1)
  assert.equal(historical.comments[0].replies?.length, 1)
  assert.equal(historical.nodes[0].id, first.nodes[0].id)
  assert.equal(reviewAtRound(session, 2), current)
  assert.equal(comparisonSnapshot(session)?.round, 1)
})

test('explicit origin rounds distinguish repeated revision strings and legacy locations are labelled inferred', () => {
  const review = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], '第二轮意见')
  review.comments[0].originRound = 2
  const session: ReviewSession = { schemaVersion: 1, id: 'test', round: 2, version: 2, phase: 'awaiting-review', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', review, history: [], snapshots: [
    { round: 1, openedAt: '2026-11-03T00:00:00Z', review: structuredClone(sampleReview) }, { round: 2, openedAt: '2026-11-03T00:01:00Z', review: structuredClone(review) },
  ] }
  assert.deepEqual(commentOrigin(session, review.comments[0]), { round: 2, exact: true })
  assert.equal(reviewAtRound(session, 1).comments.length, 0)
  delete review.comments[0].originRound
  assert.equal(commentOrigin(session, review.comments[0])?.exact, false)
})

test('publication metadata validates normalized source manifests and rejects malformed provenance', () => {
  const source = { algorithm: 'sha256-path-content-v1', checkedAt: '2026-11-03T00:00:00Z', fingerprint: 'a'.repeat(64), files: [{ path: 'src/logic.ts', sha256: 'b'.repeat(64) }] }
  assert.equal(parsePublication({ baseRound: 1, summary: '更新条件', source }).baseRound, 1)
  for (const baseRound of [51, 10_000_001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parsePublication({ baseRound, summary: '继续本次审查', source }).baseRound, baseRound)
  }
  for (const baseRound of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePublication({ baseRound, summary: '更新条件', source }))
  }
  for (const input of [{ baseRound: 0, summary: 'x', source }, { baseRound: 1, summary: '', source }, { baseRound: 1, summary: 'x', source: { ...source, files: [{ path: '../secret', sha256: 'b'.repeat(64) }] } }]) assert.throws(() => parsePublication(input))
})
