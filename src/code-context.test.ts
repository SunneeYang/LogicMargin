import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Text } from '@codemirror/state'
import { Chunk } from '@codemirror/merge'
import { contextFolds, expandContextFold } from './code-context.ts'

test('context expansion reveals only twenty whole lines at the requested edge', () => {
  const doc = Text.of(Array.from({ length: 100 }, (_, index) => `行 ${index} 😀`))
  const fold = { id: 7, from: doc.line(10).from, to: doc.line(80).to }
  const down = expandContextFold(doc, fold, 'start')!
  assert.deepEqual(down, { ...fold, from: doc.line(30).from })
  const up = expandContextFold(doc, down, 'end')!
  assert.deepEqual(up, { ...down, to: doc.line(60).to })
  const remainder = expandContextFold(doc, up, 'end')!
  assert.equal(doc.lineAt(remainder.to).number - doc.lineAt(remainder.from).number + 1, 11)
  assert.equal(expandContextFold(doc, remainder, 'start'), null)
  assert.equal(expandContextFold(doc, fold, 'all'), null)
  assert.deepEqual(fold, { id: 7, from: doc.line(10).from, to: doc.line(80).to })
})

test('paired context gaps stay aligned after insertions and deletions change offsets', () => {
  const original = Array.from({ length: 160 }, (_, index) => `const item${index} = ${index};`)
  const changed = [...original]
  changed.splice(110, 2, 'changed_later();')
  changed.splice(30, 1, 'changed_first();', 'inserted();', 'inserted_again();')
  const a = Text.of(original), b = Text.of(changed)
  const chunks = Chunk.build(a, b)
  const before = contextFolds(a, chunks.map(chunk => ({ from: chunk.fromA, to: chunk.toA })))
  const after = contextFolds(b, chunks.map(chunk => ({ from: chunk.fromB, to: chunk.toB })))
  assert.equal(before.length, 3)
  assert.deepEqual(before.map(fold => fold.id), after.map(fold => fold.id))
  for (const [index, fold] of before.entries()) {
    const other = after[index]
    assert.equal(a.sliceString(fold.from, fold.to), b.sliceString(other.from, other.to))
    for (const edge of ['start', 'end'] as const) {
      const left = expandContextFold(a, fold, edge), right = expandContextFold(b, other, edge)
      assert.equal(left && a.sliceString(left.from, left.to), right && b.sliceString(right.from, right.to))
    }
  }
  assert.deepEqual(contextFolds(Text.of(['']), []), [])
})

test('the same boundary repeatedly advances until no hidden lines remain', () => {
  const doc = Text.of(Array.from({ length: 210 }, (_, index) => `line ${index}`))
  const initial = { id: 4, from: doc.line(10).from, to: doc.line(110).to }
  for (const edge of ['start', 'end'] as const) {
    let fold: typeof initial | null = initial
    for (let clicks = 1; clicks <= 5; clicks++) {
      fold = expandContextFold(doc, fold!, edge)
      assert.ok(fold)
      assert.equal(fold.id, 4)
      assert.equal(doc.lineAt(fold.to).number - doc.lineAt(fold.from).number + 1, 101 - clicks * 20)
    }
    assert.equal(expandContextFold(doc, fold!, edge), null)
  }
})
