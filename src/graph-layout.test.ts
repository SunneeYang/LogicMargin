import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { layoutGraph } from './graph-layout.ts'
import type { LayoutNode, LayoutPoint } from './graph-layout.ts'
import { parseReview } from './model.ts'
import { sampleReview } from './sample.ts'
import type { ReviewDocument, ReviewEdge, ReviewNode } from './types.ts'

const node = (id: string): ReviewNode => ({
  id, sceneId: 'scene', title: id, kind: 'action', summary: '', detail: '', input: '', output: '',
  position: { x: -999, y: -999 }, evidence: [],
})
const edge = (id: string, source: string, target: string): ReviewEdge => ({
  id, sceneId: 'scene', source, target, label: '继续', detail: '',
})
const overlaps = (a: LayoutNode, b: LayoutNode) => a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x
  && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y

function crossesInterior(a: LayoutPoint, b: LayoutPoint, node: LayoutNode) {
  let enter = 0, exit = 1
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, node.position.x + 0.01, node.position.x + node.width - 0.01],
    [a.y, b.y - a.y, node.position.y + 0.01, node.position.y + node.height - 0.01],
  ]) {
    if (delta === 0) { if (start < min || start > max) return false; continue }
    const one = (min - start) / delta, two = (max - start) / delta
    enter = Math.max(enter, Math.min(one, two))
    exit = Math.min(exit, Math.max(one, two))
    if (enter >= exit) return false
  }
  return enter < exit
}

test('topology replaces collapsed input coordinates without changing the review', () => {
  const nodes = ['start', 'left', 'right', 'end'].map(node)
  const edges = [edge('s-l', 'start', 'left'), edge('s-r', 'start', 'right'), edge('l-e', 'left', 'end'), edge('r-e', 'right', 'end')]
  const original = structuredClone({ nodes, edges })
  const result = layoutGraph(nodes, edges)
  assert.deepEqual({ nodes, edges }, original)
  assert.deepEqual([...result.nodes.keys()], nodes.map(item => item.id))
  const placed = [...result.nodes.values()]
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) assert.equal(overlaps(placed[i], placed[j]), false)
  }
  assert.ok(result.nodes.get('start')!.position.y < result.nodes.get('left')!.position.y)
  assert.ok(result.nodes.get('left')!.position.y < result.nodes.get('end')!.position.y)
  assert.notEqual(result.nodes.get('left')!.position.x, result.nodes.get('right')!.position.x)
  assert.equal(result.nodes.get('end')!.ports.filter(port => port.type === 'target').length, 2)
})

test('parallel edges have separate routes, handles and boundary ports', () => {
  const result = layoutGraph(['start', 'end'].map(node), [edge('yes', 'start', 'end'), edge('no', 'start', 'end')])
  const one = result.edges.get('yes')!, two = result.edges.get('no')!
  assert.notDeepEqual(one.points, two.points)
  assert.notEqual(one.sourceHandle, two.sourceHandle)
  assert.notEqual(one.targetHandle, two.targetHandle)
  const sourcePorts = result.nodes.get('start')!.ports
  assert.equal(sourcePorts.length, 2)
  assert.notDeepEqual([sourcePorts[0].side, sourcePorts[0].offset], [sourcePorts[1].side, sourcePorts[1].offset])
  for (const placed of result.nodes.values()) {
    for (const port of placed.ports) {
      const span = port.side === 'top' || port.side === 'bottom' ? placed.width : placed.height
      assert.ok(port.offset >= -0.001 && port.offset <= span + 0.001)
    }
  }
})

test('self loops and reverse cycles preserve direction and finite route coordinates', () => {
  const edges = [edge('forward', 'a', 'b'), edge('back', 'b', 'a'), edge('loop', 'a', 'a')]
  const result = layoutGraph(['a', 'b'].map(node), edges)
  for (const item of edges) {
    const route = result.edges.get(item.id)!
    assert.ok(route.points.length >= 3)
    assert.ok([...route.points, route.label].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
    assert.ok(result.nodes.get(item.source)!.ports.some(port => port.id === route.sourceHandle && port.type === 'source'))
    assert.ok(result.nodes.get(item.target)!.ports.some(port => port.id === route.targetHandle && port.type === 'target'))
  }
  const loop = result.edges.get('loop')!
  const a = result.nodes.get('a')!
  assert.ok(loop.points.some(point => point.x > a.position.x + a.width))
  assert.notDeepEqual(loop.points[0], loop.points.at(-1))
})

test('measured sizes produce separated nodes and exact boundary endpoints', () => {
  const sizes = new Map([['short', { width: 248, height: 128 }], ['tall', { width: 320, height: 368 }]])
  const result = layoutGraph(['short', 'tall'].map(node), [edge('down', 'short', 'tall')], sizes)
  const short = result.nodes.get('short')!, tall = result.nodes.get('tall')!
  assert.equal(short.height, 128)
  assert.equal(tall.height, 368)
  assert.equal(tall.width, 320)
  assert.equal(overlaps(short, tall), false)
  const route = result.edges.get('down')!
  assert.equal(route.points[0].y, short.position.y + short.height)
  assert.equal(route.points.at(-1)!.y, tall.position.y)
})

test('empty and disconnected graphs remain valid, while missing endpoints are explicit errors', () => {
  const empty = layoutGraph([], [])
  assert.equal(empty.nodes.size, 0)
  assert.equal(empty.edges.size, 0)
  const disconnected = layoutGraph(['a', 'b', 'c'].map(node), [])
  assert.equal(disconnected.nodes.size, 3)
  assert.equal(new Set([...disconnected.nodes.values()].map(item => JSON.stringify(item.position))).size, 3)
  assert.throws(() => layoutGraph([node('a')], [edge('broken', 'a', 'missing')]), /broken.*不存在/)
})

test('twenty-way fan-in and fan-out keep ports visually separated', () => {
  const nodes = Array.from({ length: 21 }, (_, index) => node(`n${index}`))
  for (const reverse of [false, true]) {
    const edges = nodes.slice(1).map((item, index) => edge(`e${index}`, reverse ? item.id : 'n0', reverse ? 'n0' : item.id))
    const ports = layoutGraph(nodes, edges).nodes.get('n0')!.ports
    assert.equal(ports.length, 20)
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const offsets = ports.filter(port => port.side === side).map(port => port.offset).sort((a, b) => a - b)
      for (let index = 1; index < offsets.length; index++) assert.ok(offsets[index] - offsets[index - 1] >= 8)
    }
  }
})

test('all bundled scenes route shared failure exits without entering unrelated nodes or sharing ports', () => {
  const spirit: ReviewDocument = parseReview(JSON.parse(readFileSync(new URL('../public/reviews/spirit-sanctum.logic-margin.json', import.meta.url), 'utf8')))
  for (const review of [sampleReview, spirit]) {
    for (const scene of review.scenes) {
      const nodes = review.nodes.filter(item => item.sceneId === scene.id)
      const edges = review.edges.filter(item => item.sceneId === scene.id)
      const result = layoutGraph(nodes, edges)
      for (const [id, placed] of result.nodes) {
        const offsets = placed.ports.map(port => `${port.side}:${port.offset.toFixed(6)}`)
        assert.equal(new Set(offsets).size, offsets.length, `${scene.id}: duplicated ports at ${id}`)
      }
      for (const item of edges) {
        const route = result.edges.get(item.id)!
        for (const [id, placed] of result.nodes) {
          if (id === item.source || id === item.target) continue
          for (let index = 1; index < route.points.length; index++) {
            assert.equal(crossesInterior(route.points[index - 1], route.points[index], placed), false, `${scene.id}: ${item.id} crosses ${id}`)
          }
        }
      }
    }
  }
})
