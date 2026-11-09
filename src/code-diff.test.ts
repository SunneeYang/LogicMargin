import { test } from 'node:test'
import assert from 'node:assert/strict'
import { associationComparison, collectCodeReferences, pairCodeReferences, prioritizeCodePairs } from './code-diff.ts'
import type { CodePair, CodeReference } from './code-diff.ts'
import { buildUnifiedDiff } from './unified-code-diff.ts'
import { sampleReview } from './sample.ts'

function reference(code: string | undefined, startLine = 1, digest = code ?? 'legacy'): CodeReference {
  return { evidence: { path: 'src/rules.ts', symbol: 'canUpgrade', startLine, endLine: startLine + (code?.split('\n').length ?? 1) - 1, digest, ...(code !== undefined ? { code } : {}) }, nodeIds: ['upgrade'], nodeTitles: ['升级条件'] }
}

test('matching keeps shifted unique symbols together and refuses ambiguous repeated symbols', () => {
  const pairs = pairCodeReferences([reference('old', 10)], [reference('new', 30)])
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].before?.evidence.startLine, 10)
  assert.equal(pairs[0].after?.evidence.startLine, 30)
  const ambiguous = pairCodeReferences([reference('a', 1), reference('b', 10)], [reference('c', 30), reference('d', 40)])
  assert.equal(ambiguous.length, 4)
  assert.ok(ambiguous.every(pair => pair.ambiguous && !(pair.before && pair.after)))
  const reordered = pairCodeReferences([reference('stable', 1), reference('old', 10)], [reference('new', 30), reference('stable', 40)])
  assert.equal(reordered.length, 2)
  assert.equal(reordered.find(pair => pair.before?.evidence.code === 'stable')?.after?.evidence.startLine, 40)
  assert.equal(reordered.find(pair => pair.before?.evidence.code === 'old')?.after?.evidence.code, 'new')
})

test('node and edge selection collects only relevant evidence and merges shared references', () => {
  const review = structuredClone(sampleReview)
  review.nodes = review.nodes.slice(0, 3)
  const [source, target, unrelated] = review.nodes
  source.evidence = [reference('source').evidence]
  target.evidence = [reference('source').evidence, { ...reference('target', 12).evidence, symbol: 'applyUpgrade' }]
  unrelated.evidence = [{ ...reference('unrelated').evidence, path: 'src/other.ts' }]
  review.edges = [{ id: 'selected-edge', sceneId: source.sceneId, source: source.id, target: target.id, label: '通过', detail: '条件通过后执行' }]
  const selected = collectCodeReferences(review, [{ kind: 'edge', id: 'selected-edge' }, { kind: 'node', id: source.id }])
  assert.equal(selected.length, 2)
  assert.deepEqual(selected[0].nodeIds, [source.id, target.id])
  assert.ok(selected.every(item => item.evidence.path === 'src/rules.ts'))
  assert.deepEqual(collectCodeReferences(review, [{ kind: 'node', id: 'removed-node' }]), [])
})

test('matching follows stable nodes when same-symbol excerpts exchange source line positions', () => {
  const eligibilityBefore = { ...reference('checkOldEligibility', 10), nodeIds: ['eligibility'] }
  const balanceBefore = { ...reference('checkOldBalance', 20), nodeIds: ['balance'] }
  const eligibilityAfter = { ...reference('checkNewEligibility', 20), nodeIds: ['eligibility'] }
  const balanceAfter = { ...reference('checkNewBalance', 10), nodeIds: ['balance'] }
  const pairs = pairCodeReferences([eligibilityBefore, balanceBefore], [balanceAfter, eligibilityAfter])
  assert.equal(pairs.length, 2)
  assert.equal(pairs.find(pair => pair.before === eligibilityBefore)?.after, eligibilityAfter)
  assert.equal(pairs.find(pair => pair.before === balanceBefore)?.after, balanceAfter)
  const sameNode = pairCodeReferences([reference('old first', 10), reference('old second', 20)], [reference('new first', 20), reference('new second', 10)])
  assert.equal(sameNode.length, 4)
  assert.ok(sameNode.every(pair => pair.ambiguous && !(pair.before && pair.after)))
  const unrelated = pairCodeReferences([eligibilityBefore], [{ ...eligibilityAfter, nodeIds: ['new-step'] }])
  assert.equal(unrelated.length, 2)
  assert.ok(unrelated.every(pair => pair.ambiguous && !(pair.before && pair.after)))
})

test('changed and newly linked snippets precede unchanged code and old instructions', () => {
  const same = { key: 'same', before: reference('same'), after: reference('same'), ambiguous: false }
  const removed = { key: 'old-instructions', before: reference('old instructions'), ambiguous: false }
  const added = { key: 'new-code', after: reference('new code'), ambiguous: false }
  const changed = { key: 'changed', before: reference('before'), after: reference('after'), ambiguous: false }
  const original = [removed, same, added, changed]
  assert.deepEqual(prioritizeCodePairs(original).map(pair => pair.key), ['changed', 'new-code', 'old-instructions', 'same'])
  assert.deepEqual(original.map(pair => pair.key), ['old-instructions', 'same', 'new-code', 'changed'])
})

test('association comparisons use saved text and exact UTF-16 ranges without inventing a baseline source', () => {
  for (const code of ['', 'export const enabled = true;', '中文🫠\n\nlast\n', 'x'.repeat(100000), Array.from({ length: 2000 }, (_, i) => `line${i}`).join('\n')]) {
    for (const added of [false, true]) {
      const saved = reference(code, 29)
      const pair: CodePair = { key: added ? 'add' : 'remove', ...(added ? { after: saved } : { before: saved }), ambiguous: false }
      const comparison = associationComparison(pair)!
      assert.ok(comparison)
      assert.equal(comparison.before.code, added ? '' : code)
      assert.equal(comparison.after.code, added ? code : '')
      assert.equal((added ? comparison.after : comparison.before), saved.evidence)
      assert.equal(comparison.diff.before.length, comparison.before.code!.length)
      assert.equal(comparison.diff.after.length, comparison.after.code!.length)
      assert.deepEqual(comparison.diff.changes, code ? [{ fromA: 0, toA: added ? 0 : code.length, fromB: 0, toB: added ? code.length : 0 }] : [])
      assert.equal(pair.before === undefined, added)
      assert.equal(pair.after === undefined, !added)
      const unified = buildUnifiedDiff(comparison.before.code!, comparison.after.code!, comparison.diff)
      assert.equal(unified.lines.filter(line => line.kind !== 'added').map(line => line.text).join('\n'), comparison.before.code)
      assert.equal(unified.lines.filter(line => line.kind !== 'removed').map(line => line.text).join('\n'), comparison.after.code)
    }
  }
  assert.equal(associationComparison({ key: 'legacy', after: reference(undefined), ambiguous: false }), undefined)
  assert.equal(associationComparison({ key: 'ambiguous', after: reference('saved'), ambiguous: true }), undefined)
  assert.equal(associationComparison({ key: 'both', before: reference('a'), after: reference('b'), ambiguous: false }), undefined)
})
