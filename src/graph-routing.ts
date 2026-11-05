import { measureEdgeLabel } from './graph-label.ts'
import type { LayoutEdge, LayoutNode, LayoutPoint, LayoutPort } from './graph-layout.ts'
import type { ReviewEdge, ReviewNode } from './types.ts'

type Box = { x: number; y: number; width: number; height: number }
type Segment = { a: LayoutPoint; b: LayoutPoint }
const clearance = 24
const trackSpacing = 16
const intersects = (a: Box, b: Box, gap = 0) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
  && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
const box = (node: LayoutNode): Box => ({ ...node.position, width: node.width, height: node.height })
const labelBox = (point: LayoutPoint, width: number, height: number): Box => ({ x: point.x - width / 2, y: point.y - height / 2, width, height })

function crosses(a: LayoutPoint, b: LayoutPoint, obstacle: Box, padding = 0) {
  const left = obstacle.x - padding, right = obstacle.x + obstacle.width + padding
  const top = obstacle.y - padding, bottom = obstacle.y + obstacle.height + padding
  return a.x === b.x
    ? a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom
    : a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right
}

function compact(points: LayoutPoint[]) {
  const result: LayoutPoint[] = []
  for (const point of points) {
    const last = result.at(-1)
    if (last?.x === point.x && last.y === point.y) continue
    const before = result.at(-2)
    if (before && last && (before.x === last.x && last.x === point.x || before.y === last.y && last.y === point.y)) result.pop()
    result.push(point)
  }
  return result
}

function portPoint(node: LayoutNode, port: LayoutPort, outside = 0): LayoutPoint {
  return {
    x: node.position.x + (port.side === 'left' ? -outside : port.side === 'right' ? node.width + outside : port.offset),
    y: node.position.y + (port.side === 'top' ? -outside : port.side === 'bottom' ? node.height + outside : port.offset),
  }
}

function segments(points: LayoutPoint[]): Segment[] { return points.slice(1).map((b, index) => ({ a: points[index], b })) }

export function authoredLayout(
  nodes: readonly ReviewNode[], edges: readonly ReviewEdge[], sizes: ReadonlyMap<string, { width: number; height: number }>,
) {
  if (nodes.length < 2 || nodes.some(node => !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))
    || new Set(nodes.map(node => `${node.position.x}:${node.position.y}`)).size !== nodes.length) return undefined
  // Collapsed or overlapping draft coordinates do not carry usable stage/lane order.
  if (nodes.some((node, index) => nodes.slice(index + 1).some(other => intersects(
    { ...node.position, width: 248, height: 160 }, { ...other.position, width: 248, height: 160 },
  )))) return undefined
  const byId = new Map(nodes.map(node => [node.id, node]))
  for (const edge of edges) if (!byId.has(edge.source) || !byId.has(edge.target)) throw new Error(`连线 ${edge.id} 引用了不存在的节点`)
  const columns = [...new Set(nodes.map(node => node.position.x))].sort((a, b) => a - b)
  const rows = [...new Set(nodes.map(node => node.position.y))].sort((a, b) => a - b)
  const dimension = (node: ReviewNode) => ({ width: sizes.get(node.id)?.width || 248, height: sizes.get(node.id)?.height || 160 })
  const largestLabel = Math.max(24, ...edges.map(edge => measureEdgeLabel(edge.label).height + 16))
  const rowGap = Math.max(120, largestLabel * 2 + 32)
  const xPositions = new Map<number, number>(), yPositions = new Map<number, number>()
  let x = 24, y = 24
  for (const column of columns) {
    xPositions.set(column, x)
    x += Math.max(...nodes.filter(node => node.position.x === column).map(node => dimension(node).width)) + 264
  }
  for (const row of rows) {
    yPositions.set(row, y)
    y += Math.max(...nodes.filter(node => node.position.y === row).map(node => dimension(node).height)) + rowGap
  }
  const placed = new Map<string, LayoutNode>(nodes.map(node => [node.id, {
    position: { x: xPositions.get(node.position.x)!, y: yPositions.get(node.position.y)! }, ...dimension(node), ports: [],
  }]))
  return { nodes: placed, edges: routeGraphEdges(placed, edges, new Map(nodes.map(node => [node.id, node.kind]))) }
}

export function routeGraphEdges(
  placed: Map<string, LayoutNode>, edges: readonly ReviewEdge[], nodeKinds: ReadonlyMap<string, ReviewNode['kind']>,
): Map<string, LayoutEdge> {
  const nodes = [...placed].map(([id, node]) => ({ id, kind: nodeKinds.get(id) ?? 'action', position: node.position }))
  const byId = new Map(nodes.map(node => [node.id, node]))
  for (const edge of edges) if (!byId.has(edge.source) || !byId.has(edge.target)) throw new Error(`连线 ${edge.id} 引用了不存在的节点`)
  for (const node of placed.values()) node.ports = []
  const columns = [...new Set(nodes.map(node => node.position.x))].sort((a, b) => a - b)
  const rows = [...new Set(nodes.map(node => node.position.y))].sort((a, b) => a - b)
  const dimension = (node: { id: string }) => placed.get(node.id)!
  const xPositions = new Map(columns.map(column => [column, column]))
  const yPositions = new Map(rows.map(row => [row, row]))
  const labels = new Map(edges.map(edge => {
    const measured = measureEdgeLabel(edge.label)
    return [edge.id, { width: Math.max(120, measured.width), height: measured.height + 16 }]
  }))
  const widestLabel = Math.max(120, ...[...labels.values()].map(label => label.width))
  const rowGap = Math.max(120, Math.max(24, ...[...labels.values()].map(label => label.height)) * 2 + 32)
  const boxes = [...placed.values()].map(box)
  const left = Math.min(...boxes.map(node => node.x))
  const kinds = new Map<string, NonNullable<LayoutEdge['kind']>>()
  const endpoints = new Map<string, { source: LayoutPort; target: LayoutPort }>()
  const gutters = new Map<string, number>()
  const rowCorridors = (node: LayoutNode) => [node.position.y - clearance - 8, node.position.y + node.height + clearance + 8]
  const corridorXs = columns.flatMap(column => {
    const members = nodes.filter(node => node.position.x === column)
    const start = xPositions.get(column)!, end = start + Math.max(...members.map(node => dimension(node).width))
    return [start - 64, start - clearance, end + clearance, end + 64, end + 132, end + 200]
  })
  const corridorYs = rows.flatMap(row => {
    const start = yPositions.get(row)!, end = start + Math.max(...nodes.filter(node => node.position.y === row).map(node => dimension(node).height))
    return [start - clearance - 8, end + clearance + 8, end + rowGap / 2, end + rowGap - clearance - 8]
  })
  for (const edge of edges) {
    const source = byId.get(edge.source)!, target = byId.get(edge.target)!
    const returning = target.position.y <= source.position.y
    const sideExit = target.kind === 'failure' || target.kind === 'result' && target.position.x !== source.position.x && !edges.some(item => item.source === target.id)
    const kind = sideExit ? 'exception' : returning ? 'return' : 'flow'
    kinds.set(edge.id, kind)
    let sourceSide: LayoutPort['side'], targetSide: LayoutPort['side']
    if (kind === 'return' && source.position.x === target.position.x) sourceSide = targetSide = edge.source === edge.target ? 'right' : 'left'
    else if (returning && source.position.x === target.position.x) sourceSide = targetSide = 'right'
    else if (source.position.x === target.position.x) { sourceSide = 'bottom'; targetSide = 'top' }
    else { sourceSide = source.position.x < target.position.x ? 'right' : 'left'; targetSide = sourceSide === 'right' ? 'left' : 'right' }
    const sourcePort: LayoutPort = { id: `source:${edge.id}`, type: 'source', side: sourceSide, offset: 0 }
    const targetPort: LayoutPort = { id: `target:${edge.id}`, type: 'target', side: targetSide, offset: 0 }
    placed.get(edge.source)!.ports.push(sourcePort); placed.get(edge.target)!.ports.push(targetPort)
    endpoints.set(edge.id, { source: sourcePort, target: targetPort })
  }
  for (const node of placed.values()) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => {
        const partner = (port: LayoutPort) => {
          const edge = edges.find(edge => `${port.type}:${edge.id}` === port.id)!
          return placed.get(port.type === 'source' ? edge.target : edge.source)!.position
        }
        const one = partner(a), two = partner(b)
        const feedbackTarget = (port: LayoutPort) => (side === 'left' || side === 'right') && port.type === 'target'
        const oneReturns = feedbackTarget(a), twoReturns = feedbackTarget(b)
        if (oneReturns !== twoReturns) return Number(oneReturns) - Number(twoReturns)
        if (oneReturns) {
          const approach = (point: LayoutPoint) => Math.sign(point.y - node.position.y)
          return approach(one) - approach(two) || two.y - one.y || b.id.localeCompare(a.id)
        }
        return (side === 'left' || side === 'right' ? one.y - two.y : one.x - two.x) || a.id.localeCompare(b.id)
      })
      const span = side === 'top' || side === 'bottom' ? node.width : node.height
      ports.forEach((port, index) => { port.offset = 16 + (span - 32) * (index + 1) / (ports.length + 1) })
      const fromBelow = (port: LayoutPort) => {
        if (port.type !== 'target') return false
        const edge = edges.find(edge => `target:${edge.id}` === port.id)!
        return placed.get(edge.source)!.position.y > node.position.y
      }
      const gutterOrder = [...ports.filter(port => !fromBelow(port)), ...ports.filter(fromBelow).reverse()]
      const neighboringGap = Math.min(Infinity, ...boxes.filter(other => side === 'left' ? other.x + other.width <= node.position.x
        : side === 'right' && other.x >= node.position.x + node.width).map(other => side === 'left'
        ? node.position.x - other.x - other.width : other.x - node.position.x - node.width))
      const gutterStep = Math.min(trackSpacing, Math.max(0, neighboringGap - clearance * 2) / Math.max(1, ports.length - 1))
      gutterOrder.forEach((port, index) => gutters.set(port.id, clearance + (side === 'left' || side === 'right' ? index * gutterStep : 0)))
    }
  }
  const routes = new Map<string, LayoutEdge>(), occupiedLabels: Box[] = [], occupiedSegments: Segment[] = []
  const parallelTracks = (coordinate: number, horizontal: boolean) => {
    const occupied = occupiedSegments.filter(line => horizontal ? line.a.y === line.b.y : line.a.x === line.b.x)
      .map(line => horizontal ? line.a.y : line.a.x)
    const free = (value: number) => occupied.every(prior => Math.abs(value - prior) >= trackSpacing - .01)
    if (free(coordinate)) return [coordinate]
    return [coordinate, ...[-1, 1].map(direction => {
      let value = coordinate
      for (let step = 0; step <= occupied.length; step++) {
        value += direction * trackSpacing
        if (free(value)) break
      }
      return value
    })]
  }
  let returnLane = 0
  const selfLanes = new Map<string, number>()
  // Forward stages are placed first; feedback stays in dedicated outer channels.
  const ordered = [...edges].sort((a, b) => {
    const priority = (edge: ReviewEdge) => kinds.get(edge.id) === 'return' ? 2 : kinds.get(edge.id) === 'exception' ? 1 : 0
    return priority(a) - priority(b) || Math.abs(byId.get(a.source)!.position.y - byId.get(a.target)!.position.y)
      - Math.abs(byId.get(b.source)!.position.y - byId.get(b.target)!.position.y) || a.id.localeCompare(b.id)
  })
  for (const edge of ordered) {
    const source = placed.get(edge.source)!, target = placed.get(edge.target)!, ports = endpoints.get(edge.id)!
    const first = portPoint(source, ports.source), last = portPoint(target, ports.target)
    const start = portPoint(source, ports.source, gutters.get(ports.source.id)!), end = portPoint(target, ports.target, gutters.get(ports.target.id)!)
    const label = labels.get(edge.id)!, kind = kinds.get(edge.id)!
    const self = edge.source === edge.target
    const lane = self ? selfLanes.get(edge.source) ?? 0 : kind === 'return' ? returnLane++ : 0
    if (self) selfLanes.set(edge.source, lane + 1)
    const laneX = self ? source.position.x + source.width + widestLabel + 48 + lane * trackSpacing
      : source.position.x !== target.position.x ? (start.x + end.x) / 2 : left - widestLabel / 2 - 48 - lane * trackSpacing
    const baseRails = kind === 'return' ? [laneX] : kind === 'exception'
      ? corridorXs.filter(x => x >= Math.min(start.x, end.x))
      : source.position.x === target.position.x ? corridorXs.filter(x => x >= source.position.x + source.width + clearance) : corridorXs
    const rails = [...new Set(baseRails.flatMap(rail => parallelTracks(rail, false)))]
    const candidates: LayoutPoint[][] = []
    const add = (points: LayoutPoint[]) => {
      const middle = compact(points)
      if (segments(middle).some(segment => boxes.some(node => crosses(segment.a, segment.b, node, 16)))) return
      candidates.push(compact([first, ...middle, last]))
    }
    if (start.x === end.x || start.y === end.y) add([start, end])
    if (kind === 'return') for (const rail of rails) add([start, { x: rail, y: start.y }, { x: rail, y: end.y }, end])
    if (kind !== 'return') {
      for (const rail of rails) add([start, { x: rail, y: start.y }, { x: rail, y: end.y }, end])
      for (const rail of corridorYs.flatMap(rail => parallelTracks(rail, true))) add([start, { x: start.x, y: rail }, { x: end.x, y: rail }, end])
    }
    const sourceTracks = rowCorridors(source).flatMap(rail => parallelTracks(rail, true))
    const targetTracks = rowCorridors(target).flatMap(rail => parallelTracks(rail, true))
    for (const rail of rails) for (const startY of sourceTracks) for (const endY of targetTracks) {
      add([start, { x: start.x, y: startY }, { x: rail, y: startY }, { x: rail, y: endY }, { x: end.x, y: endY }, end])
    }
    let best: { points: LayoutPoint[]; label: LayoutPoint; collisions: number; score: number } | undefined
    for (const points of candidates) {
      const lines = segments(points)
      const length = lines.reduce((sum, segment) => sum + Math.abs(segment.a.x - segment.b.x) + Math.abs(segment.a.y - segment.b.y), 0)
      let wireCost = 0
      for (const line of lines) {
        for (const prior of occupiedSegments) {
          if (line.a.x === line.b.x && prior.a.x === prior.b.x) wireCost += Math.max(0, Math.min(Math.max(line.a.y, line.b.y), Math.max(prior.a.y, prior.b.y)) - Math.max(Math.min(line.a.y, line.b.y), Math.min(prior.a.y, prior.b.y))) * Math.max(0, trackSpacing - Math.abs(line.a.x - prior.a.x)) * 1000
          else if (line.a.y === line.b.y && prior.a.y === prior.b.y) wireCost += Math.max(0, Math.min(Math.max(line.a.x, line.b.x), Math.max(prior.a.x, prior.b.x)) - Math.max(Math.min(line.a.x, line.b.x), Math.min(prior.a.x, prior.b.x))) * Math.max(0, trackSpacing - Math.abs(line.a.y - prior.a.y)) * 1000
          else if ((line.a.x === line.b.x) !== (prior.a.x === prior.b.x)) {
            const vertical = line.a.x === line.b.x ? line : prior, horizontal = line.a.y === line.b.y ? line : prior
            if (vertical.a.x >= Math.min(horizontal.a.x, horizontal.b.x) && vertical.a.x <= Math.max(horizontal.a.x, horizontal.b.x)
              && horizontal.a.y >= Math.min(vertical.a.y, vertical.b.y) && horizontal.a.y <= Math.max(vertical.a.y, vertical.b.y)) wireCost += 480
          }
        }
        wireCost += occupiedLabels.filter(obstacle => crosses(line.a, line.b, obstacle, 4)).length * 3000
      }
      for (const line of lines) {
        const vertical = line.a.x === line.b.x
        const span = Math.abs(vertical ? line.a.y - line.b.y : line.a.x - line.b.x)
        if (span < (vertical ? label.height : label.width) + 12) continue
        for (const fraction of [.5, .25, .75, .15, .85]) {
          const point = { x: line.a.x + (line.b.x - line.a.x) * fraction, y: line.a.y + (line.b.y - line.a.y) * fraction }
          const bounds = labelBox(point, label.width, label.height)
          if (boxes.some(node => intersects(bounds, node, 12))) continue
          const collisions = occupiedLabels.filter(prior => intersects(bounds, prior, 8)).length
          const labelCost = occupiedSegments.filter(prior => crosses(prior.a, prior.b, bounds, 4)).length * 3000
          const score = length + points.length * 24 + wireCost + labelCost
          if (!best || collisions < best.collisions || collisions === best.collisions && score < best.score) best = { points, label: point, collisions, score }
        }
      }
    }
    if (!best) throw new Error(`未能在节点外布置连线 ${edge.id}`)
    routes.set(edge.id, { points: best.points, label: best.label, sourceHandle: ports.source.id, targetHandle: ports.target.id,
      labelWidth: label.width, labelHeight: label.height, kind })
    occupiedLabels.push(labelBox(best.label, label.width, label.height)); occupiedSegments.push(...segments(best.points))
  }
  return new Map(edges.map(edge => [edge.id, routes.get(edge.id)!]))
}
