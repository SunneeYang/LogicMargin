import { Graph, layout } from '@dagrejs/dagre'
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre'
import type { ReviewEdge, ReviewNode } from './types.ts'
import { authoredPositions, gridPositions, routeGraphEdges } from './graph-routing.ts'
import { measureEdgeLabel } from './graph-label.ts'

export interface LayoutPoint { x: number; y: number }
export interface LayoutPort {
  id: string
  type: 'source' | 'target'
  side: 'top' | 'right' | 'bottom' | 'left'
  offset: number
}
export interface LayoutNode {
  position: LayoutPoint
  width: number
  height: number
  ports: LayoutPort[]
}
export interface LayoutEdge {
  points: LayoutPoint[]
  label: LayoutPoint
  sourceHandle: string
  targetHandle: string
  labelWidth?: number
  labelHeight?: number
  kind?: 'flow' | 'return' | 'exception'
}

export function layoutGraph(
  nodes: readonly ReviewNode[], edges: readonly ReviewEdge[],
  sizes: ReadonlyMap<string, { width: number; height: number }> = new Map(),
) {
  const placed = layoutNodePositions(nodes, edges, sizes)
  return { ...placed, edges: routeGraphEdges(placed.nodes, edges, new Map(nodes.map(node => [node.id, node.kind]))) }
}

export function layoutNodePositions(
  nodes: readonly ReviewNode[], edges: readonly ReviewEdge[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
) {
  const authored = authoredPositions(nodes, edges, sizes)
  if (authored) return { nodes: authored, usesAuthoredPositions: true }
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ directed: true, multigraph: true })
  graph.setGraph({ rankdir: 'TB', ranksep: 88, nodesep: 72, edgesep: 32, marginx: 24, marginy: 24 })
  // Seed Dagre's crossing reducer with normal steps first, keeping each group's original order.
  const kindOrder = { action: 0, decision: 0, result: 1, failure: 2 }
  for (const node of [...nodes].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind])) {
    const measured = sizes.get(node.id)
    graph.setNode(node.id, { width: measured?.width || 248, height: measured?.height || 160 })
  }
  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) throw new Error(`连线 ${edge.id} 引用了不存在的节点`)
    const label = measureEdgeLabel(edge.label)
    graph.setEdge(edge.source, edge.target, {
      width: Math.max(120, label.width), height: label.height + 16, labelpos: 'c',
    }, edge.id)
  }
  if (nodes.length) layout(graph)
  const positioned = nodes.map(node => {
    const { x, y } = graph.node(node.id)
    if (x === undefined || y === undefined) throw new Error(`未能布局节点 ${node.id}`)
    return { ...node, position: { x, y } }
  })
  // Keep Dagre's rank/lane order, with the same clearance and orthogonal router as authored diagrams.
  const placed = gridPositions(positioned, edges, sizes)
  return { nodes: placed, usesAuthoredPositions: false }
}
