import type { LayoutPoint } from './graph-layout.ts'

export function edgePointsAtHandles(points: readonly LayoutPoint[], source: LayoutPoint, target: LayoutPoint) {
  const distinct = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  const route = distinct.filter((point, index) => !index || index === distinct.length - 1 ||
    !(distinct[index - 1].x === point.x && point.x === distinct[index + 1].x || distinct[index - 1].y === point.y && point.y === distinct[index + 1].y))
  if (route.length < 2) return route
  const horizontalStart = route[0].y === route[1].y
  const horizontalEnd = route.at(-2)!.y === route.at(-1)!.y
  if (route.length === 2) {
    if (source.x === target.x || source.y === target.y) return [source, target]
    const x = (source.x + target.x) / 2, y = (source.y + target.y) / 2
    return horizontalStart ? [source, { x, y: source.y }, { x, y: target.y }, target]
      : [source, { x: source.x, y }, { x: target.x, y }, target]
  }
  // DOM rounding and node lift move the handles; move their adjacent corners without tilting either segment.
  route[0] = source
  route[route.length - 1] = target
  route[1] = horizontalStart ? { ...route[1], y: source.y } : { ...route[1], x: source.x }
  const lastCorner = route.length - 2
  route[lastCorner] = horizontalEnd ? { ...route[lastCorner], y: target.y } : { ...route[lastCorner], x: target.x }
  return route
}

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
