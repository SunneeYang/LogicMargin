import { layoutGraph } from './graph-layout.ts'
export { compareGraphIds } from './graph-order.ts'
import { comparisonLayout } from './graph-focus.ts'
import type { ReviewEdge, ReviewNode } from './types.ts'

// shortcut: Dagre clones only acyclic arrays/plain data; revisit if its clone inputs change.
globalThis.structuredClone ??= function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Unsupported Dagre clone value')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T
  }
  return value
}

interface LayoutInput {
  nodes: ReviewNode[]
  edges: ReviewEdge[]
  reference?: { nodes: ReviewNode[]; edges: ReviewEdge[] }
  sizes: { id: string; width: number; height: number }[]
}

export function computeJSON(json: string): string {
  const input: LayoutInput = JSON.parse(json)
  const sizes = new Map((input.sizes ?? []).map(({ id, width, height }) => [id, { width, height }]))
  const result = input.reference
    ? comparisonLayout(input.nodes ?? [], input.edges ?? [], input.reference.nodes ?? [], input.reference.edges ?? [], sizes)
    : layoutGraph(input.nodes ?? [], input.edges ?? [], sizes)
  // The build exposes comparisonLayout's existing authored decision without rerunning its union layout.
  const usesAuthoredPositions = (result as typeof result & { usesAuthoredPositions: boolean }).usesAuthoredPositions
  if (typeof usesAuthoredPositions !== 'boolean') throw new Error('Missing layout provenance; rebuild graph.bundle.js')
  return JSON.stringify({ nodes: Object.fromEntries(result.nodes), edges: Object.fromEntries(result.edges), usesAuthoredPositions })
}
