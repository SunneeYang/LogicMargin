import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectCodeReferences, diffCode, diffCodePair, pairCodeReferences, splitDiffLines } from './code-diff.ts'
import type { CodeReference } from './code-diff.ts'
import { sampleReview } from './sample.ts'

function reference(code: string | undefined, startLine = 1, digest = code ?? 'legacy'): CodeReference {
  return { evidence: { path: 'src/rules.ts', symbol: 'canUpgrade', startLine, endLine: startLine + (code?.split('\n').length ?? 1) - 1, digest, ...(code !== undefined ? { code } : {}) }, nodeIds: ['upgrade'], nodeTitles: ['升级条件'] }
}

test('code diff preserves both source excerpts and their actual line numbers', () => {
  const before = 'function ready() {\n  return oldRule\n}\n'
  const after = 'function ready() {\n  checkInput()\n  return newRule\n}\n'
  const result = diffCode(before, after, 20, 34)
  assert.equal(result.limited, false)
  assert.equal(result.lines.filter(line => line.kind !== 'added').map(line => line.text).join('\n'), before)
  assert.equal(result.lines.filter(line => line.kind !== 'removed').map(line => line.text).join('\n'), after)
  assert.deepEqual(result.lines.filter(line => line.kind === 'removed').map(line => [line.beforeLine, line.text]), [[21, '  return oldRule']])
  assert.deepEqual(result.lines.filter(line => line.kind === 'added').map(line => [line.afterLine, line.text]), [[35, '  checkInput()'], [36, '  return newRule']])
  const split = splitDiffLines(result.lines)
  assert.equal(split.filter(row => row.before).map(row => row.before!.text).join('\n'), before)
  assert.equal(split.filter(row => row.after).map(row => row.after!.text).join('\n'), after)
  assert.equal(split.find(row => row.after?.text === '  return newRule')?.before, undefined)
})

test('insertions, deletions, blank lines and unchanged snippets retain source meaning', () => {
  const added = diffCode('start\nend', 'start\n\nnext\nend')
  assert.deepEqual(added.lines.filter(line => line.kind === 'added').map(line => line.text), ['', 'next'])
  assert.equal(added.lines.some(line => line.kind === 'removed'), false)
  const removed = diffCode('start\nobsolete\nend', 'start\nend')
  assert.deepEqual(removed.lines.filter(line => line.kind === 'removed').map(line => line.text), ['obsolete'])
  assert.equal(removed.lines.some(line => line.kind === 'added'), false)
  assert.ok(diffCode('\treturn 中文\n', '\treturn 中文\n', 10, 40).lines.every(line => line.kind === 'context'))
  assert.deepEqual(diffCode('', '').lines, [{ kind: 'context', text: '', beforeLine: 1, afterLine: 1 }])
})

test('a missing excerpt or unpaired association never becomes fabricated added or removed code', () => {
  for (const pair of [
    { before: reference(undefined), after: reference('return true') },
    { before: reference('return false'), after: reference(undefined) },
    { after: reference('return true') },
    { before: reference('return false') },
  ]) assert.equal(diffCodePair({ key: 'test', ambiguous: false, ...pair }), undefined)
  assert.equal(diffCodePair({ key: 'blank', ambiguous: false, before: reference(''), after: reference('') })?.lines[0].kind, 'context')
})

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

test('large excerpts have an explicit bounded fallback rather than a synthetic replacement diff', () => {
  const longLines = Array.from({ length: 1100 }, (_, index) => `line ${index}`).join('\n')
  assert.deepEqual(diffCode(longLines, `${longLines}\nextra`), { lines: [], limited: true })
  assert.deepEqual(diffCode('a'.repeat(250_000), 'short'), { lines: [], limited: true })
})
