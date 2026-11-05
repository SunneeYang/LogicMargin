import { Graph, layout } from '@dagrejs/dagre'
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre'
import type { ReviewEdge, ReviewNode } from './types.ts'
import { authoredLayout } from './graph-routing.ts'
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

function addPort(node: LayoutNode, point: LayoutPoint, id: string, type: LayoutPort['type']) {
  const x = point.x - node.position.x, y = point.y - node.position.y
  const sides: LayoutPort['side'][] = ['top', 'right', 'bottom', 'left']
  const distances = [Math.abs(y), Math.abs(x - node.width), Math.abs(y - node.height), Math.abs(x)]
  const side = sides[distances.indexOf(Math.min(...distances))]
  node.ports.push({ id, type, side, offset: side === 'top' || side === 'bottom' ? x : y })
}

export function layoutGraph(
  nodes: readonly ReviewNode[], edges: readonly ReviewEdge[],
  sizes: ReadonlyMap<string, { width: number; height: number }> = new Map(),
) {
  const authored = authoredLayout(nodes, edges, sizes)
  if (authored) return { ...authored, usesAuthoredPositions: true }
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
  const placed = new Map<string, LayoutNode>()
  const routes = new Map<string, LayoutEdge>()
  const portPoints = new Map<string, LayoutPoint>()
  for (const node of nodes) {
    const { x, y, width, height } = graph.node(node.id)
    if (x === undefined || y === undefined) throw new Error(`未能布局节点 ${node.id}`)
    placed.set(node.id, { position: { x: x - width / 2, y: y - height / 2 }, width, height, ports: [] })
  }
  for (const edge of edges) {
    const route = graph.edge({ v: edge.source, w: edge.target, name: edge.id })
    const points = route.points
    if (!points?.length) throw new Error(`未能布局连线 ${edge.id}`)
    const sourceHandle = `source:${edge.id}`, targetHandle = `target:${edge.id}`
    addPort(placed.get(edge.source)!, points[0], sourceHandle, 'source')
    addPort(placed.get(edge.target)!, points.at(-1)!, targetHandle, 'target')
    portPoints.set(sourceHandle, points[0])
    portPoints.set(targetHandle, points.at(-1)!)
    const middle = points[Math.floor(points.length / 2)]
    routes.set(edge.id, {
      points, label: { x: route.x ?? middle.x, y: route.y ?? middle.y }, sourceHandle, targetHandle,
      labelWidth: route.width, labelHeight: route.height,
    })
  }
  // Dagre's ray intersections crowd high-fan ports near corners; retain their order while spacing them along the boundary.
  for (const node of placed.values()) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.offset - b.offset || a.id.localeCompare(b.id))
      if (ports.length < 2) continue
      const horizontal = side === 'top' || side === 'bottom'
      const span = horizontal ? node.width : node.height
      const inset = Math.min(16, span / 4)
      ports.forEach((port, index) => {
        port.offset = inset + (span - inset * 2) * (index + 1) / (ports.length + 1)
        const point = portPoints.get(port.id)!
        point.x = node.position.x + (horizontal ? port.offset : side === 'left' ? 0 : node.width)
        point.y = node.position.y + (horizontal ? side === 'top' ? 0 : node.height : port.offset)
      })
    }
  }
  return { nodes: placed, edges: routes, usesAuthoredPositions: false }
}
