import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { layoutGraph } from './graph-layout.ts'
import { routeGraphEdges } from './graph-routing.ts'
import { comparisonLayout } from './graph-focus.ts'
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

function longestSharedTrack(routes: ReadonlyMap<string, { points: LayoutPoint[] }>) {
  let longest = 0
  const entries = [...routes.values()]
  for (let one = 0; one < entries.length; one++) for (let two = one + 1; two < entries.length; two++) {
    const first = entries[one].points, second = entries[two].points
    for (let a = 1; a < first.length; a++) for (let b = 1; b < second.length; b++) {
      const p = first[a - 1], q = first[a], r = second[b - 1], s = second[b]
      if (p.x === q.x && r.x === s.x && p.x === r.x) {
        longest = Math.max(longest, Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)))
      } else if (p.y === q.y && r.y === s.y && p.y === r.y) {
        longest = Math.max(longest, Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)))
      }
    }
  }
  return longest
}

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

test('short conditions reserve width for revision and comment status in both layout paths', () => {
  const collapsed = ['start', 'end'].map(node)
  const authored = collapsed.map((item, index) => ({ ...item, position: { x: 0, y: index * 220 } }))
  for (const nodes of [collapsed, authored]) {
    const route = layoutGraph(nodes, [edge('continue', 'start', 'end')]).edges.get('continue')!
    assert.ok(route.labelWidth! >= 120)
    assert.ok(route.labelHeight! >= 40)
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

test('authored stages keep a cyclic workbench narrow and route every condition around cards', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ ...node(`stage-${index}`),
    kind: index === 10 ? 'failure' as const : index === 9 || index === 11 ? 'result' as const : 'action' as const,
    position: { x: index >= 10 ? 600 : 0, y: index === 10 ? 880 : index === 11 ? 440 : index * 220 },
  }))
  const pairs = [[0, 1], [0, 10], [1, 2], [1, 11], [1, 10], [2, 3], [2, 4], [2, 7], [2, 8], [2, 11],
    [3, 2], [3, 10], [3, 11], [4, 5], [4, 10], [4, 11], [5, 2], [5, 6], [6, 2], [6, 2],
    [7, 7], [7, 2], [7, 2], [7, 11], [8, 2], [8, 9], [8, 10], [8, 11], [10, 0], [9, 0], [2, 10]]
  const edges = pairs.map(([source, target], index) => ({ ...edge(`condition-${index}`, `stage-${source}`, `stage-${target}`),
    label: index % 3 ? '条件通过后继续处理' : '读取失败或当前状态已经改变，结束本次处理',
  }))
  const result = layoutGraph(nodes, edges)
  const placed = [...result.nodes.values()]
  assert.ok(Math.max(...placed.map(item => item.position.x + item.width)) - Math.min(...placed.map(item => item.position.x)) < 1600)
  for (let index = 1; index < 10; index++) assert.ok(result.nodes.get(`stage-${index}`)!.position.y > result.nodes.get(`stage-${index - 1}`)!.position.y)
  assert.equal(result.edges.size, edges.length)
  assert.ok(longestSharedTrack(result.edges) <= 24, 'independent conditions must not share long track segments')
  const labelBoxes: LayoutNode[] = []
  for (const edge of edges) {
    const route = result.edges.get(edge.id)!
    const bounds = { position: { x: route.label.x - route.labelWidth! / 2, y: route.label.y - route.labelHeight! / 2 }, width: route.labelWidth!, height: route.labelHeight!, ports: [] }
    assert.ok(bounds.width > 0 && bounds.height >= 40)
    assert.ok(placed.every(item => !overlaps(bounds, item)), `${edge.id}: condition covers a card`)
    assert.ok(labelBoxes.every(item => !overlaps(bounds, item)), `${edge.id}: conditions overlap`)
    labelBoxes.push(bounds)
    for (let index = 1; index < route.points.length; index++) {
      const one = route.points[index - 1], two = route.points[index]
      assert.ok(one.x === two.x || one.y === two.y, `${edge.id}: route is not orthogonal`)
      for (const [id, item] of result.nodes) {
        if (id === edge.source || id === edge.target) continue
        assert.equal(crossesInterior(one, two, item), false, `${edge.id}: crosses ${id}`)
      }
    }
  }
  assert.equal(result.edges.get('condition-24')!.kind, 'return')
  assert.equal(result.edges.get('condition-26')!.kind, 'exception')
  const comparisonNodes = nodes.map((item, index) => ({ ...item, title: index ? `处理步骤 ${index}` : '准备执行',
    summary: '核对本步骤的输入和结果；失败时保留当前状态。',
  }))
  const baselineNodes = structuredClone(comparisonNodes)
  comparisonNodes[4].summary += ' 当前实现增加了再次核对。'
  const comparison = comparisonLayout(comparisonNodes, edges, baselineNodes, edges,
    new Map(comparisonNodes.map((item, index) => [item.id, { width: 248, height: index === 4 ? 170 : 148 }])))
  const comparisonLabels = [...comparison.edges].map(([id, route]) => ({ id, position: {
    x: route.label.x - route.labelWidth! / 2, y: route.label.y - route.labelHeight! / 2,
  }, width: route.labelWidth!, height: route.labelHeight!, ports: [] }))
  for (let index = 0; index < comparisonLabels.length; index++) {
    for (const other of comparisonLabels.slice(index + 1)) assert.equal(overlaps(comparisonLabels[index], other), false,
      `comparison conditions overlap: ${comparisonLabels[index].id} / ${other.id}`)
  }
  assert.ok(longestSharedTrack(comparison.edges) <= 24)
  const reordered = layoutGraph([...nodes].reverse(), [...edges].reverse())
  for (const item of nodes) assert.deepEqual(reordered.nodes.get(item.id)!.position, result.nodes.get(item.id)!.position)
  for (const item of edges) assert.deepEqual(reordered.edges.get(item.id), result.edges.get(item.id))
  const positions = [...result.nodes].map(([id, item]) => [id, item.position])
  const subset = edges.slice(0, 2)
  const rerouted = routeGraphEdges(result.nodes, subset, new Map(nodes.map(item => [item.id, item.kind])))
  assert.deepEqual([...result.nodes].map(([id, item]) => [id, item.position]), positions)
  assert.deepEqual([...rerouted.keys()], subset.map(item => item.id))
  assert.equal([...result.nodes.values()].reduce((sum, item) => sum + item.ports.length, 0), subset.length * 2)
})

test('high-fan returns use separate parallel tracks and ordered station entrances', () => {
  const nodes = Array.from({ length: 9 }, (_, index) => ({ ...node(`station-${index}`), position: { x: 0, y: index * 220 } }))
  const edges = nodes.slice(1).flatMap((item, index) => [
    edge(`out-${index}`, 'station-0', item.id),
    { ...edge(`back-${index}`, item.id, 'station-0'), label: index % 2 ? '继续' : '条件条件条件条件条abcdefgh' },
  ])
  const result = layoutGraph(nodes, edges)
  assert.equal(result.edges.size, edges.length)
  assert.ok(longestSharedTrack(result.edges) <= 24, `shared track length: ${longestSharedTrack(result.edges)}`)
  const ports = result.nodes.get('station-0')!.ports.filter(port => port.side === 'left').sort((a, b) => a.offset - b.offset)
  for (let index = 1; index < ports.length; index++) assert.ok(ports[index].offset - ports[index - 1].offset >= 8)
})

test('nine failure exits keep independent tracks and staggered station approaches', () => {
  const positions = [[0, 0], [0, 220], [0, 440], [600, 440], [0, 660], [600, 880],
    [0, 880], [0, 1100], [0, 1320], [600, 1320], [0, 1540], [0, 1760]]
  const nodes = positions.map(([x, y], index) => ({ ...node(`step-${index}`), position: { x, y },
    kind: index === 3 || index === 9 ? 'failure' as const : index === 11 ? 'result' as const : 'action' as const,
  }))
  const pairs = [[0, 1], [0, 9], [1, 2], [1, 9], [2, 3], [2, 4], [4, 6], [4, 5], [4, 9], [5, 7],
    [6, 7], [5, 9], [6, 9], [7, 8], [7, 9], [8, 9], [8, 10], [10, 11], [10, 9], [11, 9]]
  const edges = pairs.map(([source, target], index) => ({ ...edge(`condition-${index}`, `step-${source}`, `step-${target}`),
    label: '条件成立后继续'.repeat(index % 3 + 1),
  }))
  for (const sizes of [new Map(), ...[150, 150.5].map(height => new Map(nodes.map(item => [item.id, { width: 248, height }])))]) {
    const result = layoutGraph(nodes, edges, sizes)
    assert.equal(result.edges.size, edges.length)
    assert.ok(longestSharedTrack(result.edges) <= 24)
    const approaches = edges.filter(item => item.target === 'step-9').flatMap(item => {
      const route = result.edges.get(item.id)!, target = result.nodes.get('step-9')!
      const port = target.ports.find(port => port.id === route.targetHandle)!
      const turn = route.points.at(-2)!, prior = route.points.at(-3)!
      return port.side === 'left' && turn.x === prior.x ? [{ x: turn.x, low: Math.min(turn.y, prior.y), high: Math.max(turn.y, prior.y) }] : []
    })
    for (let one = 0; one < approaches.length; one++) for (let two = one + 1; two < approaches.length; two++) {
      const a = approaches[one], b = approaches[two]
      if (Math.min(a.high, b.high) > Math.max(a.low, b.low)) assert.ok(Math.abs(a.x - b.x) >= 8)
    }
    const labelBoxes: LayoutNode[] = []
    for (const item of edges) {
      const route = result.edges.get(item.id)!
      const bounds = { position: { x: route.label.x - route.labelWidth! / 2, y: route.label.y - route.labelHeight! / 2 }, width: route.labelWidth!, height: route.labelHeight!, ports: [] }
      assert.ok([...result.nodes.values()].every(node => !overlaps(bounds, node)))
      assert.ok(labelBoxes.every(prior => !overlaps(bounds, prior)))
      labelBoxes.push(bounds)
    }
  }
})
