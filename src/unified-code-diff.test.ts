import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUnifiedDiff } from './unified-code-diff.ts'

test('unified display reconstructs both source versions including blank lines, EOF and Unicode', () => {
  const examples = ['', '\n', '\n\n', 'abc', 'abc\n', 'a\nb', 'a\nx\nb', '甲😀\n\n乙\n', '\nc\n', '\nx\n\nc\nx\n']
  for (const before of examples) for (const after of examples) {
    const result = buildUnifiedDiff(before, after)
    assert.equal(result.lines.filter(line => line.kind !== 'added').map(line => line.text).join('\n'), before)
    assert.equal(result.lines.filter(line => line.kind !== 'removed').map(line => line.text).join('\n'), after)
    assert.deepEqual(result.lines.flatMap(line => line.before === undefined ? [] : [line.before]), before.split('\n').map((_, index) => index + 1))
    assert.deepEqual(result.lines.flatMap(line => line.after === undefined ? [] : [line.after]), after.split('\n').map((_, index) => index + 1))
    assert.ok(result.marks.every(mark => mark.from >= 0 && mark.to <= result.doc.length))
  }
})

test('large deletion keeps every source line and collapses only unchanged context', () => {
  const before = Array.from({ length: 2000 }, (_, index) => `const item${index} = ${index};`).join('\n')
  const after = before.split('\n').slice(1900).join('\n')
  const result = buildUnifiedDiff(before, after)
  assert.equal(result.changes.length, 1)
  assert.equal(result.lines.filter(line => line.kind === 'removed').length, 1900)
  assert.equal(result.lines.at(-1)?.after, 100)
  for (const fold of result.folds) {
    const from = result.doc.lineAt(fold.from).number - 1, to = result.doc.lineAt(fold.to).number
    assert.ok(result.lines.slice(from, to).every(line => !line.kind))
  }
})

test('empty diff fragments do not become unchanged navigation stops', () => {
  const before = ['{{{', '}barbar', '', '', '{b}}', ' c } c ', ' c foo', 'onst x = 1;bconst x = 1; c ',
    'const x = 1;{}b', 'const x = 1;', ' c a', '}bar', '{foobara', 'const x = 1;const x = 1;{', 'fooconst x = 1;', 'barfoo c'].join('\n')
  const after = ['barbarb}}', ' c } c ', 'oo', 'foo c const x = 1;', ' c a', '}bar', '{foobara',
    'const x = 1;const x = 1;{', 'fooconst x = 1;', 'a', 'b c {', '}', ' c bfoo{', ''].join('\n')
  const result = buildUnifiedDiff(before, after)
  for (let index = 0; index < result.changes.length; index++) {
    const from = result.doc.lineAt(result.changes[index]).number - 1
    const to = result.doc.lineAt(Math.min(result.doc.length, result.changeEnds[index] - 1)).number
    const lines = result.lines.slice(from, to)
    assert.notDeepEqual(lines.filter(line => line.kind === 'removed').map(line => line.text),
      lines.filter(line => line.kind === 'added').map(line => line.text))
  }
})
