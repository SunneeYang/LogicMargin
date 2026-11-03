import type { LayoutPoint } from './graph-layout.ts'

export function smoothEdgePath(points: readonly LayoutPoint[]) {
  const route = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  if (!route.length) return ''
  let path = `M${route[0].x},${route[0].y}`
  for (let index = 1; index < route.length - 1; index++) {
    const previous = route[index - 1], corner = route[index], next = route[index + 1]
    const incoming = { x: corner.x - previous.x, y: corner.y - previous.y }
    const outgoing = { x: next.x - corner.x, y: next.y - corner.y }
    if (incoming.x * outgoing.y === incoming.y * outgoing.x) {
      path += ` L${corner.x},${corner.y}`
      continue
    }
    const before = Math.hypot(incoming.x, incoming.y), after = Math.hypot(outgoing.x, outgoing.y)
    // Half-segment limits keep adjacent curves in route order, including short returns.
    const radius = Math.min(20, before / 2, after / 2)
    const entry = { x: corner.x - incoming.x * radius / before, y: corner.y - incoming.y * radius / before }
    const exit = { x: corner.x + outgoing.x * radius / after, y: corner.y + outgoing.y * radius / after }
    path += ` L${entry.x},${entry.y} Q${corner.x},${corner.y} ${exit.x},${exit.y}`
  }
  const last = route.at(-1)!
  return route.length > 1 ? `${path} L${last.x},${last.y}` : path
}
