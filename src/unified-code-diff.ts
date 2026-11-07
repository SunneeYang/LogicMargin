import { Text } from '@codemirror/state'
import { Chunk } from '@codemirror/merge'

export interface UnifiedLine {
  text: string
  before?: number
  after?: number
  kind?: 'removed' | 'added'
}

export function buildUnifiedDiff(before: string, after: string) {
  const a = Text.of(before.split('\n')), b = Text.of(after.split('\n'))
  const chunks = Chunk.build(a, b, { scanLimit: 2000, timeout: 100 })
    .filter(chunk => chunk.changes.some(change => change.fromA !== change.toA || change.fromB !== change.toB))
  const lines: UnifiedLine[] = []
  const marks: { from: number; to: number; kind: 'removed' | 'added' }[] = []
  const changes: number[] = []
  const changeEnds: number[] = []
  let oldLine = 0, newLine = 0, offset = 0
  const append = (doc: Text, from: number, to: number, kind?: UnifiedLine['kind']) => {
    for (let index = from; index < to; index++) {
      const text = doc.line(index + 1).text
      lines.push({ text, kind, ...(kind !== 'added' ? { before: oldLine++ + 1 } : {}),
        ...(kind !== 'removed' ? { after: newLine++ + 1 } : {}) })
      offset += text.length + 1
    }
  }
  for (const chunk of chunks) {
    const first = chunk.changes[0], last = chunk.changes.at(-1)!
    const startLineA = a.lineAt(chunk.fromA + first.fromA), startLineB = b.lineAt(chunk.fromB + first.fromB)
    const toA = chunk.fromA + last.toA, toB = chunk.fromB + last.toB
    const endLineA = a.lineAt(toA), endLineB = b.lineAt(toB)
    const exclusive = endLineA.from === toA && endLineB.from === toB
    const startA = startLineA.number - 1, startB = startLineB.number - 1
    const endA = endLineA.number - (exclusive ? 1 : 0), endB = endLineB.number - (exclusive ? 1 : 0)
    append(a, oldLine, startA)
    changes.push(offset)
    const deletedAt = offset
    append(a, startA, endA, 'removed')
    const addedAt = offset
    append(b, startB, endB, 'added')
    changeEnds.push(offset)
    for (const change of chunk.changes) {
      if (change.toA > change.fromA) marks.push({ from: deletedAt + chunk.fromA - startLineA.from + change.fromA,
        to: deletedAt + chunk.fromA - startLineA.from + change.toA, kind: 'removed' })
      if (change.toB > change.fromB) marks.push({ from: addedAt + chunk.fromB - startLineB.from + change.fromB,
        to: addedAt + chunk.fromB - startLineB.from + change.toB, kind: 'added' })
    }
  }
  append(b, newLine, b.lines)
  const doc = Text.of(lines.map(line => line.text))
  const folds: { from: number; to: number; lines: number }[] = []
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind) { index++; continue }
    const start = index
    while (index < lines.length && !lines[index].kind) index++
    const from = start + (start ? 3 : 0), to = index - (index < lines.length ? 3 : 0)
    if (to - from >= 8) folds.push({ from: doc.line(from + 1).from, to: doc.line(to).to, lines: to - from })
  }
  return { doc, lines, marks: marks.map(mark => ({ ...mark, to: Math.min(mark.to, doc.length) })).filter(mark => mark.to > mark.from),
    changes, changeEnds, folds, precise: chunks.every(chunk => chunk.precise) }
}
