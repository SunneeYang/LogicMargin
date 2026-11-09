import { validStructure } from './structural-code-diff.ts'
import type { StructureResult } from './structural-code-diff.ts'
import type { Evidence, ReviewEdge, ReviewNode } from './types.ts'
import type { LayoutEdge, LayoutNode } from './graph-layout.ts'

export type SnapshotSelector = { kind: 'baseline' } | { kind: 'round'; round: number }
export interface DiffContext {
  sessionId: string
  beforeSnapshot: SnapshotSelector
  afterSnapshot: SnapshotSelector
}
export type SourceReference = Omit<Evidence, 'code'>
export interface DiffInput {
  beforeSnapshot: SnapshotSelector
  afterSnapshot: SnapshotSelector
  before: SourceReference
  after: SourceReference
}
export interface ComputedDiff {
  schemaVersion: 1
  algorithm: string
  key: string
  language: string
  coordinate: 'utf16'
  before: { digest: string; length: number }
  after: { digest: string; length: number }
  precise: boolean
  changes: { fromA: number; toA: number; fromB: number; toB: number }[]
}
type PlanNode = Pick<ReviewNode, 'id' | 'kind' | 'position' | 'title' | 'summary'>
type PlanEdge = Pick<ReviewEdge, 'id' | 'source' | 'target' | 'label'>
export interface LayoutInput {
  nodes: PlanNode[]
  edges: PlanEdge[]
  reference?: { nodes: PlanNode[]; edges: PlanEdge[] }
  sizes: { id: string; width: number; height: number }[]
}
export interface ComputedLayout {
  schemaVersion: 1
  algorithm: string
  key: string
  nodes: Record<string, LayoutNode>
  edges: Record<string, LayoutEdge>
  usesAuthoredPositions: boolean
}
interface Capabilities {
  schemaVersion: 1
  coordinate: 'utf16'
  diffAlgorithm: string
  structureAlgorithm?: string
  layoutAlgorithm: string
}

export function sourceReference({ path, symbol, startLine, endLine, digest }: Evidence): SourceReference {
  return { path, symbol, startLine, endLine, digest }
}

export function layoutInput(nodes: readonly ReviewNode[], edges: readonly ReviewEdge[],
  sizes: ReadonlyMap<string, { width: number; height: number }>, reference?: { nodes: ReviewNode[]; edges: ReviewEdge[] }): LayoutInput {
  const graph = (nodes: readonly ReviewNode[], edges: readonly ReviewEdge[]) => ({
    nodes: nodes.map(({ id, kind, position, title, summary }) => ({ id, kind, position: { ...position }, title, summary })),
    edges: edges.map(({ id, source, target, label }) => ({ id, source, target, label })),
  })
  const ids = new Set([...nodes, ...(reference?.nodes ?? [])].map(node => node.id))
  return { ...graph(nodes, edges), ...(reference ? { reference: graph(reference.nodes, reference.edges) } : {}),
    sizes: [...sizes].filter(([id]) => ids.has(id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, size]) => ({ id, ...size })) }
}

function envelope(value: unknown, algorithm: string): boolean {
  const item = value as ComputedDiff | null
  return !!item && item.schemaVersion === 1 && item.algorithm === algorithm && typeof item.key === 'string' && !!item.key
}

export function validDiff(value: unknown, algorithm: string, input: DiffInput, before: string, after: string): value is ComputedDiff {
  const item = value as ComputedDiff | null
  if (!envelope(item, algorithm) || !item || item.coordinate !== 'utf16' || typeof item.language !== 'string' ||
    typeof item.precise !== 'boolean' || item.before?.digest !== input.before.digest || item.after?.digest !== input.after.digest ||
    item.before.length !== before.length || item.after.length !== after.length || !Array.isArray(item.changes)) return false
  const boundary = (text: string, at: number) => !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]))
  let a = 0, b = 0
  for (const change of item.changes) {
    if (!change || ![change.fromA, change.toA, change.fromB, change.toB].every(Number.isSafeInteger) ||
      change.fromA < a || change.toA < change.fromA || change.toA > before.length ||
      change.fromB < b || change.toB < change.fromB || change.toB > after.length ||
      !boundary(before, change.fromA) || !boundary(before, change.toA) || !boundary(after, change.fromB) || !boundary(after, change.toB) ||
      before.slice(a, change.fromA) !== after.slice(b, change.fromB)) return false
    a = change.toA; b = change.toB
  }
  return before.slice(a) === after.slice(b)
}

function validLayout(value: unknown, algorithm: string, input: LayoutInput): value is ComputedLayout {
  const item = value as ComputedLayout | null
  const point = (point: { x: number; y: number }) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  if (!envelope(item, algorithm) || !item || typeof item.usesAuthoredPositions !== 'boolean' || !item.nodes || !item.edges) return false
  if (Object.keys(item.nodes).length !== input.nodes.length || Object.keys(item.edges).length !== input.edges.length) return false
  return input.nodes.every(({ id }) => {
    const node = item.nodes[id]
    return node && point(node.position) && Number.isFinite(node.width) && node.width > 0 && Number.isFinite(node.height) && node.height > 0 &&
      Array.isArray(node.ports) && node.ports.every(port => port && typeof port.id === 'string' &&
        ['source', 'target'].includes(port.type) && ['top', 'right', 'bottom', 'left'].includes(port.side) && Number.isFinite(port.offset))
  }) && input.edges.every(({ id, source, target }) => {
    const edge = item.edges[id]
    return edge && Array.isArray(edge.points) && edge.points.length >= 2 && edge.points.every(point) && point(edge.label) &&
      edge.points.every((point, index) => !index || Math.abs(point.x - edge.points[index - 1].x) <= 1e-7 || Math.abs(point.y - edge.points[index - 1].y) <= 1e-7) &&
      (edge.labelWidth === undefined || Number.isFinite(edge.labelWidth)) && (edge.labelHeight === undefined || Number.isFinite(edge.labelHeight)) &&
      (edge.kind === undefined || ['flow', 'return', 'exception'].includes(edge.kind)) &&
      item.nodes[source]?.ports.some(port => port.type === 'source' && port.id === edge.sourceHandle) &&
      item.nodes[target]?.ports.some(port => port.type === 'target' && port.id === edge.targetHandle)
  })
}

// Subscribers own cancellation independently; only the last departure cancels shared work.
export function createPrecomputeClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  const cache = new Map<string, { value: unknown; bytes: number }>()
  const pending = new Map<string, { controller: AbortController; promise: Promise<unknown>; subscribers: number }>()
  let bytes = 0
  function shared<T>(key: string, compute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.value as T) }
    let task = pending.get(key)
    if (!task) {
      if (pending.size >= 32) return Promise.reject(new Error('Precompute busy'))
      const controller = new AbortController()
      task = { controller, subscribers: 0, promise: Promise.resolve().then(() => compute(controller.signal)).then(value => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const size = (key.length + JSON.stringify(value).length) * 2
        if (size <= 8 * 1024 * 1024) {
          cache.set(key, { value, bytes: size }); bytes += size
          while (cache.size > 48 || bytes > 8 * 1024 * 1024) {
            const oldest = cache.keys().next().value!
            bytes -= cache.get(oldest)!.bytes; cache.delete(oldest)
          }
        }
        return value
      }).finally(() => { if (pending.get(key)?.controller === controller) pending.delete(key) }) }
      pending.set(key, task)
    }
    const current = task
    current.subscribers++
    return new Promise<T>((resolve, reject) => {
      let done = false
      const finish = () => {
        if (done) return false
        done = true; signal?.removeEventListener('abort', abort)
        if (--current.subscribers === 0 && pending.get(key) === current) { pending.delete(key); current.controller.abort() }
        return true
      }
      const abort = () => { if (finish()) reject(new DOMException('Aborted', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
      current.promise.then(value => { if (finish()) resolve(value as T) }, error => { if (finish()) reject(error) })
    })
  }
  async function json(path: string, signal: AbortSignal, body?: unknown, timeout = body === undefined ? 2000 : 8000) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    const response = await fetcher(path, { signal, ...(body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) })
    if (!response.ok) throw new Error('Precompute unavailable')
    return response.json()
  }
  async function capabilities(signal?: AbortSignal) {
    return shared<Capabilities | null>('capabilities', async signal => {
      try {
        const item = await json('/api/precompute', signal) as Capabilities
        return item?.schemaVersion === 1 && item.coordinate === 'utf16' && typeof item.diffAlgorithm === 'string' && !!item.diffAlgorithm &&
          typeof item.layoutAlgorithm === 'string' && !!item.layoutAlgorithm ? item : null
      } catch (error) { if (signal.aborted) throw error; return null }
    }, signal)
  }
  return {
    async diff(sessionId: string | undefined, input: DiffInput, before: string, after: string, signal?: AbortSignal): Promise<ComputedDiff | null> {
      if (!sessionId) return null
      try {
        const caps = await capabilities(signal)
        if (!caps) return null
        const result = await shared(JSON.stringify(['diff', caps.schemaVersion, caps.diffAlgorithm, sessionId, input]), async signal => {
          const result: unknown = await json(`/api/review-sessions/${encodeURIComponent(sessionId)}/precompute/diff`, signal, input)
          if (!validDiff(result, caps.diffAlgorithm, input, before, after)) throw new Error('Invalid computed diff')
          return result
        }, signal)
        return validDiff(result, caps.diffAlgorithm, input, before, after) ? result : null
      } catch (error) { if (signal?.aborted) throw error; return null }
    },
    async structure(sessionId: string | undefined, input: DiffInput, before: string, after: string, signal?: AbortSignal): Promise<StructureResult | null> {
      if (!sessionId) return null
      try {
        const caps = await capabilities(signal)
        if (!caps || typeof caps.structureAlgorithm !== 'string' || !caps.structureAlgorithm) return null
        const algorithm = caps.structureAlgorithm
        const result = await shared<StructureResult>(JSON.stringify(['structure', caps.schemaVersion, algorithm, sessionId, input]), async signal => {
          const value: unknown = await json(`/api/review-sessions/${encodeURIComponent(sessionId)}/precompute/structure`, signal, input, 20_000)
          if (!await validStructure(value, algorithm, caps.diffAlgorithm, input, before, after)) throw new Error('Invalid computed structure')
          return value as StructureResult
        }, signal)
        return await validStructure(result, algorithm, caps.diffAlgorithm, input, before, after) ? result : null
      } catch (error) { if (signal?.aborted) throw error; return null }
    },
    async layout(sessionId: string | undefined, input: LayoutInput, signal?: AbortSignal): Promise<ComputedLayout | null> {
      if (!sessionId) return null
      try {
        const caps = await capabilities(signal)
        if (!caps) return null
        return await shared(JSON.stringify(['layout', caps.schemaVersion, caps.layoutAlgorithm, sessionId, input]), async signal => {
          const result: unknown = await json(`/api/review-sessions/${encodeURIComponent(sessionId)}/precompute/layout`, signal, input)
          if (!validLayout(result, caps.layoutAlgorithm, input)) throw new Error('Invalid computed layout')
          return result
        }, signal)
      } catch (error) { if (signal?.aborted) throw error; return null }
    },
  }
}

export const precompute = createPrecomputeClient()
