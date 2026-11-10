import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { layoutGraph } from './graph-layout.ts'
import type { LayoutPoint } from './graph-layout.ts'
import { edgePointsAtHandles, smoothEdgePath } from './graph-path.ts'
import { parseReview } from './model.ts'
import { sampleReview } from './sample.ts'
import type { ReviewEdge, ReviewNode } from './types.ts'

function commands(path: string) {
  return [...path.matchAll(/([MLQ])([^MLQ]+)/g)].map(([, kind, coordinates]) => ({
    kind, values: coordinates.trim().split(/[\s,]+/).map(Number),
  }))
}

function samplePath(path: string) {
  const result: LayoutPoint[] = []
  let current = { x: 0, y: 0 }
  for (const { kind, values } of commands(path)) {
    const end = { x: values.at(-2)!, y: values.at(-1)! }
    if (kind === 'M') result.push(end)
    else {
      for (let step = 1; step <= 80; step++) {
        const t = step / 80, u = 1 - t
        result.push(kind === 'Q'
          ? { x: u * u * current.x + 2 * u * t * values[0] + t * t * end.x, y: u * u * current.y + 2 * u * t * values[1] + t * t * end.y }
          : { x: current.x + t * (end.x - current.x), y: current.y + t * (end.y - current.y) })
      }
    }
    current = end
  }
  return result
}

test('rounded DOM handles and lifted nodes keep every straight segment orthogonal without moving the saved route', () => {
  for (const route of [
    [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }],
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }],
  ]) {
    const saved = structuredClone(route)
    const source = { x: .5, y: -4.5 }, target = { x: route.at(-1)!.x + .5, y: route.at(-1)!.y + .5 }
    const adjusted = edgePointsAtHandles(route, source, target)
    assert.deepEqual(adjusted[0], source)
    assert.deepEqual(adjusted.at(-1), target)
    for (let index = 1; index < adjusted.length; index++) {
      const a = adjusted[index - 1], b = adjusted[index]
      assert.ok(a.x === b.x || a.y === b.y)
    }
    assert.deepEqual(route, saved)
  }
})

test('corners keep the route endpoints, tangent directions and a bounded local turn', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const original = structuredClone(points)
  const path = commands(smoothEdgePath(points))
  assert.deepEqual(points, original)
  assert.deepEqual(path[0].values, [0, 0])
  assert.deepEqual(path.at(-1)!.values, [100, 100])
  const curveIndex = path.findIndex(command => command.kind === 'Q')
  assert.ok(curveIndex > 0)
  const entry = path[curveIndex - 1].values, curve = path[curveIndex].values
  assert.equal(entry[1], 0)
  assert.equal(curve[2], 100)
  assert.ok(entry[0] >= 80 && entry[0] < 100)
  assert.deepEqual(curve.slice(0, 2), [100, 0])
  assert.ok(curve[3] > 0 && curve[3] <= 20)
  assert.ok(samplePath(smoothEdgePath(points)).every(point => point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100))
})

test('short consecutive turns stay in order and degenerate routes remain finite', () => {
  const short = smoothEdgePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }, { x: 20, y: 2 }])
  const sampled = samplePath(short)
  for (let index = 1; index < sampled.length; index++) {
    assert.ok(sampled[index].x >= sampled[index - 1].x - 1e-9)
    assert.ok(sampled[index].y >= sampled[index - 1].y - 1e-9)
  }
  const point = { x: -2, y: 3 }
  assert.equal(smoothEdgePath([]), '')
  assert.equal(smoothEdgePath([point, point, point]), 'M-2,3')
  const straight = smoothEdgePath([point, { x: 2, y: 3 }, { x: 5, y: 3 }])
  assert.ok(!straight.includes('Q'))
  for (const route of [[point], [point, { x: -2, y: -5 }], [point, { x: 5, y: 3 }, point], [point, point, { x: -2, y: -5 }, { x: -2, y: -5 }, { x: 3, y: -5 }]]) {
    const path = smoothEdgePath(route)
    assert.ok(commands(path).every(command => command.values.every(Number.isFinite)))
    assert.deepEqual(samplePath(path).at(-1), route.at(-1))
  }
})

test('bundled workflows and cycles preserve endpoints and avoid unrelated nodes at varied sizes', () => {
  const pipeline = parseReview(JSON.parse(readFileSync(new URL('../public/reviews/task-pipeline.logic-margin.json', import.meta.url), 'utf8')))
  const cycleNodes: ReviewNode[] = ['a', 'b'].map(id => ({
    id, sceneId: 'cycle', title: id, kind: 'action', summary: '', detail: '', input: '', output: '', position: { x: 0, y: 0 }, evidence: [],
  }))
  const cycleEdges: ReviewEdge[] = [['forward', 'a', 'b'], ['back', 'b', 'a'], ['loop', 'a', 'a']].map(([id, source, target]) => ({
    id, source, target, sceneId: 'cycle', label: '继续', detail: '',
  }))
  const scenes = [sampleReview, pipeline].flatMap(review => review.scenes.map(scene => ({
    nodes: review.nodes.filter(node => node.sceneId === scene.id), edges: review.edges.filter(edge => edge.sceneId === scene.id),
  })))
  scenes.push({ nodes: cycleNodes, edges: cycleEdges })
  for (const { nodes, edges } of scenes) {
    for (const measured of [false, true]) {
      const sizes = new Map(measured ? nodes.map((node, index) => [node.id, { width: index % 2 ? 320 : 248, height: index % 3 ? 128 : 368 }] as const) : [])
      const layout = layoutGraph(nodes, edges, sizes)
      for (const edge of edges) {
        const route = layout.edges.get(edge.id)!
        const samples = samplePath(smoothEdgePath(route.points))
        assert.ok(samples.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
        assert.deepEqual(samples[0], route.points[0])
        assert.deepEqual(samples.at(-1), route.points.at(-1))
        for (const [id, node] of layout.nodes) {
          const inside = (point: LayoutPoint) => point.x > node.position.x + 0.01 && point.x < node.position.x + node.width - 0.01
            && point.y > node.position.y + 0.01 && point.y < node.position.y + node.height - 0.01
          // Existing self-loop layout can enter its own node before smoothing.
          if (edge.source === edge.target && id === edge.source) continue
          for (const point of samples) {
            assert.equal(inside(point), false, `${edge.id} enters ${id} (${measured ? 'measured' : 'default'})`)
          }
        }
      }
    }
  }
})
