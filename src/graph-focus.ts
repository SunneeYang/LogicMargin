import { layoutNodePositions } from './graph-layout.ts'
import { compareGraphIds } from './graph-order.ts'
import { authoredPositions, gridPositions, routeGraphEdges } from './graph-routing.ts'
import type { LayoutEdge, LayoutNode } from './graph-layout.ts'
import type { ReviewEdge, ReviewNode, Target } from './types.ts'

export function availableScopeNodeIds(ids: readonly string[], nodes: readonly ReviewNode[]) {
  const available = new Set(nodes.map(node => node.id))
  return ids.filter(id => available.has(id))
}

export function relatedNodeIds(nodes: readonly ReviewNode[], edges: readonly ReviewEdge[], targets: readonly Target[]) {
  const available = new Set(nodes.map(node => node.id))
  const selected = new Set(targets.flatMap(target => {
    if (target.kind === 'scene' || target.kind === 'review') return [...available]
    if (target.kind === 'node') return available.has(target.id) ? [target.id] : []
    const edge = edges.find(item => item.id === target.id)
    return edge ? [edge.source, edge.target] : []
  }))
  const related = new Set(selected)
  for (const edge of edges) {
    if (selected.has(edge.source) || selected.has(edge.target)) {
      related.add(edge.source)
      related.add(edge.target)
    }
  }
  return [...related]
}

function estimatedHeight(node: ReviewNode) {
  const lines = (value: string, width: number) => value.split('\n').reduce((sum, line) => sum + Math.max(1,
    Math.ceil([...line].length / width)), 0)
  return Math.max(160, 90 + lines(node.title, 14) * 23 + (node.summary ? 8 + lines(node.summary, 17) * 20 : 0))
}

const edgeIdentity = (edge: ReviewEdge) => JSON.stringify([edge.id, edge.source, edge.target])

function alignedComparisonPositions(
  nodes: readonly ReviewNode[], edges: readonly ReviewEdge[],
  referenceNodes: readonly ReviewNode[], referenceEdges: readonly ReviewEdge[],
  unionNodes: readonly ReviewNode[], unionEdges: readonly ReviewEdge[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
) {
  const current = new Map(nodes.map(node => [node.id, node]))
  const reference = new Map(referenceNodes.map(node => [node.id, node]))
  const shared = unionNodes.find(node => current.has(node.id) && reference.has(node.id))
  if (!shared || !authoredPositions(nodes, edges, sizes) || !authoredPositions(referenceNodes, referenceEdges, sizes)) return
  // A canonical anchor keeps floating-point translations identical when B/R swap.
  const [anchor, moving] = current.get(shared.id) === shared ? [current, reference] : [reference, current]
  const origin = moving.get(shared.id)!.position
  const dx = shared.position.x - origin.x, dy = shared.position.y - origin.y
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  const translated = new Map<string, ReviewNode['position']>()
  for (const [id, node] of moving) {
    const position = { x: node.position.x + dx, y: node.position.y + dy }
    const fixed = anchor.get(id)?.position
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)
      || fixed && (fixed.x !== position.x || fixed.y !== position.y)) return
    translated.set(id, position)
  }
  if (!authoredPositions([...moving.values()].map(node => ({ ...node, position: translated.get(node.id)! })),
    moving === current ? edges : referenceEdges, sizes)) return
  // Exclusive nodes may share a slot; each visible side was validated separately.
  return gridPositions(unionNodes.map(node => ({ ...node, position: anchor.get(node.id)?.position ?? translated.get(node.id)! })), unionEdges, sizes)
}

export function graphBounds(nodes: ReadonlyMap<string, LayoutNode>, edges: ReadonlyMap<string, LayoutEdge>) {
  const points = [...nodes.values()].flatMap(node => [node.position,
    { x: node.position.x + node.width, y: node.position.y + node.height }])
  for (const edge of edges.values()) {
    points.push(...edge.points,
      { x: edge.label.x - (edge.labelWidth ?? 0) / 2, y: edge.label.y - (edge.labelHeight ?? 0) / 2 },
      { x: edge.label.x + (edge.labelWidth ?? 0) / 2, y: edge.label.y + (edge.labelHeight ?? 0) / 2 })
  }
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y))
  return { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y }
}

export function comparisonLayout(
  nodes: readonly ReviewNode[], edges: readonly ReviewEdge[],
  referenceNodes: readonly ReviewNode[], referenceEdges: readonly ReviewEdge[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
) {
  // Canonical union order keeps shared nodes still when the two comparison sides swap.
  const combinedNodes = new Map<string, ReviewNode>()
  const jointSizes = new Map<string, { width: number; height: number }>()
  for (const node of [...nodes, ...referenceNodes]) {
    const prior = combinedNodes.get(node.id)
    if (!prior || compareGraphIds(node.kind, prior.kind) < 0 || node.kind === prior.kind &&
      (node.position.y < prior.position.y || node.position.y === prior.position.y && node.position.x < prior.position.x)) combinedNodes.set(node.id, node)
    const measured = sizes.get(node.id)
    const priorSize = jointSizes.get(node.id)
    jointSizes.set(node.id, {
      width: Math.max(248, measured?.width ?? 0, priorSize?.width ?? 0),
      height: Math.max(estimatedHeight(node), measured?.height ?? 0, priorSize?.height ?? 0),
    })
  }
  const combinedEdges = new Map<string, ReviewEdge>()
  for (const edge of [...edges, ...referenceEdges]) {
    const key = edgeIdentity(edge)
    const prior = combinedEdges.get(key)
    if (!prior || edge.label.length > prior.label.length || edge.label.length === prior.label.length && edge.label < prior.label) combinedEdges.set(key, edge)
  }
  const routeIds = new Map<string, string>()
  const unionEdges = [...combinedEdges].sort(([a], [b]) => compareGraphIds(a, b)).map(([key, edge]) => {
    const id = `comparison:${encodeURIComponent(key)}`
    routeIds.set(key, id)
    return { ...edge, id }
  })
  const unionNodes = [...combinedNodes.values()].sort((a, b) => compareGraphIds(a.id, b.id))
  // The comparison needs union slots, but only the visible side needs line routes.
  const aligned = alignedComparisonPositions(nodes, edges, referenceNodes, referenceEdges, unionNodes, unionEdges, jointSizes)
  const { nodes: union, usesAuthoredPositions: authored } = aligned
    ? { nodes: aligned, usesAuthoredPositions: true }
    : layoutNodePositions(unionNodes, unionEdges, jointSizes)
  const placed = new Map<string, LayoutNode>()
  for (const node of nodes) {
    const joint = union.get(node.id)!
    const size = sizes.get(node.id) ?? { width: 248, height: 160 }
    placed.set(node.id, { position: joint.position, ...size, ports: [] })
  }
  const routes = new Map<string, LayoutEdge>()
  // Shared node slots stay fixed; route the visible side at its actual sizes in both placement modes.
  const routed = routeGraphEdges(placed, edges.map(edge => ({ ...edge, id: routeIds.get(edgeIdentity(edge))! })), new Map(nodes.map(node => [node.id, node.kind])))
  for (const edge of edges) routes.set(edge.id, routed.get(routeIds.get(edgeIdentity(edge))!)!)
  return { nodes: placed, edges: routes, usesAuthoredPositions: authored }
}
