import type { Evidence, ReviewDocument, Target } from './types.ts'
import type { ComputedDiff } from './precompute.ts'

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

export function codePairKind(pair: CodePair) {
  if (pair.ambiguous) return 'ambiguous'
  if (pair.before && pair.before.evidence.code === undefined || pair.after && pair.after.evidence.code === undefined) return 'unavailable'
  if (!pair.before) return 'added'
  if (!pair.after) return 'removed'
  return pair.before.evidence.code === pair.after.evidence.code ? 'unchanged' : 'changed'
}

export function prioritizeCodePairs(pairs: CodePair[]): CodePair[] {
  const priority = { changed: 0, added: 1, removed: 2, unavailable: 3, ambiguous: 4, unchanged: 5 }
  return pairs.slice().sort((a, b) => priority[codePairKind(a)] - priority[codePairKind(b)])
}

export function associationComparison(pair: CodePair): { before: Evidence; after: Evidence; diff: ComputedDiff } | undefined {
  const saved = pair.after?.evidence ?? pair.before?.evidence
  if (pair.ambiguous || !!pair.before === !!pair.after || saved?.code === undefined) return
  // The empty side denotes an absent reference, never proof that a file did not exist.
  const empty: Evidence = { ...saved, startLine: 1, endLine: 1, code: '', digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
  const before = pair.before?.evidence ?? empty, after = pair.after?.evidence ?? empty
  return { before, after, diff: { schemaVersion: 1, algorithm: 'association-text-v1', coordinate: 'utf16',
    key: JSON.stringify([pair.key, !!pair.after, saved.digest]), language: '', precise: true,
    before: { digest: before.digest, length: before.code!.length }, after: { digest: after.digest, length: after.code!.length },
    changes: saved.code ? [{ fromA: 0, toA: before.code!.length, fromB: 0, toB: after.code!.length }] : [],
  } }
}

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
