import type { Evidence, ReviewDocument, Target } from './types.ts'

export interface CodeReference {
  evidence: Evidence
  nodeIds: string[]
  nodeTitles: string[]
}

export interface CodePair {
  key: string
  before?: CodeReference
  after?: CodeReference
  ambiguous: boolean
}

export interface DiffLine {
  kind: 'context' | 'removed' | 'added'
  text: string
  beforeLine?: number
  afterLine?: number
}

const MAX_DIFF_LINES = 2000
const MAX_DIFF_CELLS = 1_000_000
const MAX_DIFF_CHARACTERS = 240_000

export function collectCodeReferences(review: ReviewDocument, targets: Target[]): CodeReference[] {
  const nodeIds = new Set<string>()
  for (const target of targets) {
    if (target.kind === 'node') nodeIds.add(target.id)
    else if (target.kind === 'edge') {
      const edge = review.edges.find(item => item.id === target.id)
      if (edge) { nodeIds.add(edge.source); nodeIds.add(edge.target) }
    } else if (target.kind === 'scene') {
      for (const node of review.nodes) if (node.sceneId === target.id) nodeIds.add(node.id)
    } else if (target.kind === 'review' && target.id === review.id) {
      for (const node of review.nodes) nodeIds.add(node.id)
    }
  }
  const references = new Map<string, CodeReference>()
  for (const node of review.nodes) {
    if (!nodeIds.has(node.id)) continue
    for (const evidence of node.evidence) {
      const key = JSON.stringify([evidence.path, evidence.symbol, evidence.startLine, evidence.endLine, evidence.digest])
      const previous = references.get(key)
      if (previous) {
        if (!previous.nodeIds.includes(node.id)) { previous.nodeIds.push(node.id); previous.nodeTitles.push(node.title) }
      } else references.set(key, { evidence, nodeIds: [node.id], nodeTitles: [node.title] })
    }
  }
  return [...references.values()]
}

export function pairCodeReferences(before: CodeReference[], after: CodeReference[]): CodePair[] {
  const groups = new Map<string, { before: CodeReference[]; after: CodeReference[] }>()
  for (const side of ['before', 'after'] as const) for (const reference of side === 'before' ? before : after) {
    const key = JSON.stringify([reference.evidence.path, reference.evidence.symbol])
    const group = groups.get(key) ?? { before: [], after: [] }
    group[side].push(reference)
    groups.set(key, group)
  }
  const pairs: CodePair[] = []
  for (const [groupKey, group] of groups) {
    let left = group.before.slice()
    let right = group.after.slice()
    const add = (old?: CodeReference, current?: CodeReference, ambiguous = false) => {
      pairs.push({ key: `${groupKey}:${pairs.length}`, before: old, after: current, ambiguous })
    }
    const sameTargets = (old: CodeReference, current: CodeReference) => old.nodeIds.some(id => current.nodeIds.includes(id))
    // Source line numbers move between versions; match stable node relations before excerpt content.
    for (const matches of [sameTargets,
      (old: CodeReference, current: CodeReference) => sameTargets(old, current) && !!old.evidence.digest && old.evidence.digest === current.evidence.digest,
      sameTargets,
    ]) {
      const matchedLeft = new Set<CodeReference>()
      const matchedRight = new Set<CodeReference>()
      for (const old of left) {
        const candidates = right.filter(item => matches(old, item))
        if (candidates.length !== 1 || left.filter(item => matches(item, candidates[0])).length !== 1) continue
        add(old, candidates[0]); matchedLeft.add(old); matchedRight.add(candidates[0])
      }
      left = left.filter(item => !matchedLeft.has(item))
      right = right.filter(item => !matchedRight.has(item))
    }
    const ambiguous = !!left.length && !!right.length
    for (const old of left) add(old, undefined, ambiguous)
    for (const current of right) add(undefined, current, ambiguous)
  }
  return pairs
}

export function diffCode(before: string, after: string, beforeStart = 1, afterStart = 1): { lines: DiffLine[]; limited: boolean } {
  const old = before.split('\n')
  const current = after.split('\n')
  // shortcut: quadratic comparison is bounded; larger excerpts remain available as unmarked source text.
  if (old.length + current.length > MAX_DIFF_LINES || (old.length + 1) * (current.length + 1) > MAX_DIFF_CELLS || before.length + after.length > MAX_DIFF_CHARACTERS) {
    return { lines: [], limited: true }
  }
  const width = current.length + 1
  const table = new Uint16Array((old.length + 1) * width)
  for (let i = old.length - 1; i >= 0; i--) for (let j = current.length - 1; j >= 0; j--) {
    table[i * width + j] = old[i] === current[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < old.length || j < current.length) {
    if (i < old.length && j < current.length && old[i] === current[j]) {
      lines.push({ kind: 'context', text: old[i], beforeLine: beforeStart + i++, afterLine: afterStart + j++ })
    } else if (i < old.length && (j === current.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      lines.push({ kind: 'removed', text: old[i], beforeLine: beforeStart + i++ })
    } else lines.push({ kind: 'added', text: current[j], afterLine: afterStart + j++ })
  }
  return { lines, limited: false }
}

export function diffCodePair(pair: CodePair) {
  const old = pair.before?.evidence
  const current = pair.after?.evidence
  return old?.code !== undefined && current?.code !== undefined ? diffCode(old.code, current.code, old.startLine, current.startLine) : undefined
}

export function splitDiffLines(lines: DiffLine[]): { before?: DiffLine; after?: DiffLine }[] {
  const rows: { before?: DiffLine; after?: DiffLine }[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ before: removed[i], after: added[i] })
    removed = []; added = []
  }
  for (const line of lines) {
    if (line.kind === 'context') { flush(); rows.push({ before: line, after: line }) }
    else (line.kind === 'removed' ? removed : added).push(line)
  }
  flush()
  return rows
}
