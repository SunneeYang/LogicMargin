import type { Text } from '@codemirror/state'

export interface ContextFold { id: number; from: number; to: number }
export type ContextEdge = 'start' | 'end' | 'all'
export const CONTEXT_LINES = 20

export function contextFolds(doc: Text, changes: readonly { from: number; to: number }[]): ContextFold[] {
  const folds: ContextFold[] = []
  let previousLine = 1
  for (let index = 0; index <= changes.length; index++) {
    const change = changes[index]
    const from = index ? previousLine + 3 : 1
    const to = change ? doc.lineAt(Math.min(doc.length, change.from)).number - 4 : doc.lines
    if (to - from + 1 >= 8) folds.push({ id: index, from: doc.line(from).from, to: doc.line(to).to })
    if (change) previousLine = doc.lineAt(Math.min(doc.length, change.to)).number
  }
  return folds
}

export function expandContextFold(doc: Text, fold: ContextFold, edge: ContextEdge): ContextFold | null {
  const first = doc.lineAt(fold.from).number, last = doc.lineAt(fold.to).number
  if (edge === 'all' || last - first + 1 <= CONTEXT_LINES) return null
  return edge === 'start' ? { ...fold, from: doc.line(first + CONTEXT_LINES).from }
    : { ...fold, to: doc.line(last - CONTEXT_LINES).to }
}
