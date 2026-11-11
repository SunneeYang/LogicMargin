import assert from 'node:assert/strict'
import { test } from 'node:test'
import { availableScopeNodeIds, comparisonLayout, graphBounds, relatedNodeIds } from './graph-focus.ts'
import { layoutGraph } from './graph-layout.ts'
import type { ReviewEdge, ReviewNode } from './types.ts'

const node = (id: string, summary = ''): ReviewNode => ({
  id, sceneId: 'scene', title: id, summary, kind: 'action', detail: '', input: '', output: '', position: { x: 0, y: 0 }, evidence: [],
})
const edge = (id: string, source: string, target: string): ReviewEdge => ({ id, sceneId: 'scene', source, target, label: id, detail: '' })

test('a disjoint placeholder baseline cannot rearrange the visible flow', () => {
  const flow: ReviewNode[] = ['start', 'check', 'work', 'done'].map((id, index) => ({
    ...node(id, 'Current flow details. '.repeat(8)), position: { x: 0, y: index * 210 },
  }))
  flow.push({ ...node('rejected'), kind: 'failure', position: { x: 480, y: 420 } })
  const edges = [edge('start-check', 'start', 'check'), edge('check-work', 'check', 'work'),
    edge('work-done', 'work', 'done'), edge('rejected', 'check', 'rejected'), edge('retry', 'work', 'check')]
  const placeholder = [node('previous-placeholder')]
  const original = structuredClone({ flow, edges, placeholder })
  for (const collapsed of [false, true]) for (const measured of [false, true]) {
    const current = collapsed ? flow.map(item => ({ ...item, position: { x: 0, y: 0 } })) : flow
    const sizes = new Map(measured ? [...current, ...placeholder].map((item, i) =>
      [item.id, { width: 248 + i * 4, height: 128 + i * 12 }] as const) : [])
    for (const [visible, visibleEdges, reference, referenceEdges] of [
      [current, edges, placeholder, []], [placeholder, [], current, edges],
    ] as const) {
      const standalone = layoutGraph(visible, visibleEdges, sizes)
      const compared = comparisonLayout(visible, visibleEdges, reference, referenceEdges, sizes)
      assert.equal(compared.usesAuthoredPositions, standalone.usesAuthoredPositions)
      for (const [id, placed] of standalone.nodes) {
        const actual = compared.nodes.get(id)!
        assert.deepEqual({ position: actual.position, width: actual.width, height: actual.height },
          { position: placed.position, width: placed.width, height: placed.height })
      }
      assert.deepEqual([...compared.nodes.keys()], visible.map(item => item.id))
      assert.deepEqual([...compared.edges.keys()], visibleEdges.map(item => item.id))
      for (const item of visibleEdges) {
        const route = compared.edges.get(item.id)!
        assert.ok(route.sourceHandle.startsWith('source:comparison:'))
        assert.ok(route.targetHandle.startsWith('target:comparison:'))
        assert.ok(compared.nodes.get(item.source)!.ports.some(port => port.id === route.sourceHandle))
        assert.ok(compared.nodes.get(item.target)!.ports.some(port => port.id === route.targetHandle))
      }
    }
  }
  assert.deepEqual({ flow, edges, placeholder }, original)
})

test('comparison preserves authored topology when exclusive steps share slots and shared steps translate together', () => {
  const positioned = (id: string, x: number, y: number) => ({ ...node(id), position: { x, y } })
  for (const offset of [0, 420, 0.125]) {
    const before = [positioned('old', 0, 0), positioned('work', 0, 210), { ...positioned('done', 0, 420), kind: 'result' as const }]
    const after = [positioned('new', 600, offset), { ...positioned('work', 600, 210 + offset), kind: 'decision' as const }, positioned('done', 600, 420 + offset)]
    const beforeEdges = [edge('start', 'old', 'work'), edge('finish', 'work', 'done')]
    const afterEdges = [edge('start', 'new', 'work'), edge('finish', 'work', 'done')]
    const original = structuredClone({ before, after })
    const a = comparisonLayout(before, beforeEdges, after, afterEdges, new Map())
    const b = comparisonLayout(after.toReversed(), afterEdges, before.toReversed(), beforeEdges, new Map())
    for (const result of [a, b]) {
      assert.equal(result.usesAuthoredPositions, true)
      assert.equal(new Set([...result.nodes.values()].map(node => node.position.x)).size, 1)
      assert.ok(graphBounds(result.nodes, result.edges).width < 600)
    }
    for (const id of ['work', 'done']) assert.deepEqual(a.nodes.get(id)!.position, b.nodes.get(id)!.position)
    assert.deepEqual({ before, after }, original)
  }
})

test('comparison conservatively rejects a translation that cannot exactly reproduce shared coordinates', () => {
  const positioned = (id: string, x: number, y: number) => ({ ...node(id), position: { x, y } })
  const before = [positioned('old', .1, -210), positioned('work', .1, 0), positioned('done', .1, 210)]
  const after = [positioned('new', .1, -210), positioned('work', 1e7, 0), positioned('done', 1e7, 210)]
  const aEdges = [edge('start', 'old', 'work'), edge('finish', 'work', 'done')]
  const bEdges = [edge('start', 'new', 'work'), edge('finish', 'work', 'done')]
  const a = comparisonLayout(before, aEdges, after, bEdges, new Map())
  const b = comparisonLayout(after, bEdges, before, aEdges, new Map())
  assert.equal(a.usesAuthoredPositions, false)
  assert.equal(b.usesAuthoredPositions, false)
  for (const id of ['work', 'done']) assert.deepEqual(a.nodes.get(id)!.position, b.nodes.get(id)!.position)
})

test('comparison keeps orthogonal routes when independently valid versions swap node lanes', () => {
  const positioned = (id: string, x: number, y: number) => ({ ...node(id), position: { x, y } })
  const before = [positioned('a', 0, 0), positioned('b', 0, 360), positioned('c', 600, 360)]
  const after = [positioned('a', 0, 0), positioned('b', 600, 360), positioned('c', 0, 360)]
  const edges = [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]
  assert.equal(layoutGraph(before, edges).usesAuthoredPositions, true)
  assert.equal(layoutGraph(after, edges).usesAuthoredPositions, true)
  for (const [nodes, reference] of [[before, after], [after, before]]) {
    const result = comparisonLayout(nodes, edges, reference, edges, new Map())
    assert.equal(result.usesAuthoredPositions, false)
    for (const [id, route] of result.edges) for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1], b = route.points[index]
      assert.ok(a.x === b.x || a.y === b.y, `${id}: diagonal comparison segment`)
    }
  }
})

test('related flow keeps one-hop context without recursively expanding a shared dispatcher', () => {
  const nodes = ['guard', 'source', 'other', 'deduplicate', 'failure', 'done'].map(id => node(id))
  const edges = [edge('dispatch-source', 'guard', 'source'), edge('dispatch-other', 'guard', 'other'),
    edge('read', 'source', 'deduplicate'), edge('reject', 'source', 'failure'), edge('finish', 'deduplicate', 'done')]
  assert.deepEqual(new Set(relatedNodeIds(nodes, edges, [{ kind: 'node', id: 'source' }])), new Set(['source', 'guard', 'deduplicate', 'failure']))
  assert.deepEqual(new Set(relatedNodeIds(nodes, edges, [{ kind: 'edge', id: 'read' }])), new Set(['source', 'deduplicate', 'guard', 'failure', 'done']))
  assert.deepEqual(relatedNodeIds(nodes, edges, [{ kind: 'node', id: 'absent' }]), [])
})

test('switching comparison sides filters missing nodes without altering the shared reading scope', () => {
  const shared = ['a', 'removed', 'added']
  assert.deepEqual(availableScopeNodeIds(shared, [node('a'), node('removed')]), ['a', 'removed'])
  assert.deepEqual(availableScopeNodeIds(shared, [node('a'), node('added')]), ['a', 'added'])
  assert.deepEqual(availableScopeNodeIds(shared, []), [])
  assert.deepEqual(shared, ['a', 'removed', 'added'])
})

test('complete graph bounds include return tracks and full condition labels outside the nodes', () => {
  const nodes = new Map([['a', { position: { x: 100, y: 100 }, width: 248, height: 160, ports: [] }]])
  const edges = new Map([['return', { points: [{ x: -80, y: 20 }, { x: -80, y: 700 }],
    label: { x: 480, y: 300 }, labelWidth: 192, labelHeight: 56, sourceHandle: 's', targetHandle: 't' }]])
  assert.deepEqual(graphBounds(nodes, edges), { x: -80, y: 20, width: 656, height: 680 })
  assert.deepEqual(graphBounds(new Map(), new Map()), { x: 0, y: 0, width: 0, height: 0 })
})

test('comparison sides choose the same authored slots even when both versions move a step', () => {
  const beforeNodes = [node('start'), node('work'), node('done')].map((item, index) => ({ ...item, position: { x: 0, y: index * 220 } }))
  const afterNodes = beforeNodes.map(item => ({ ...item, position: { x: item.position.x + 120, y: item.position.y + 100 } }))
  const edges = [edge('start-work', 'start', 'work'), edge('work-done', 'work', 'done'), edge('restart', 'done', 'start')]
  const before = comparisonLayout(beforeNodes, edges, afterNodes, edges, new Map())
  const after = comparisonLayout(afterNodes, edges, beforeNodes, edges, new Map())
  for (const item of beforeNodes) assert.deepEqual(before.nodes.get(item.id)!.position, after.nodes.get(item.id)!.position)
  assert.ok(before.nodes.get('start')!.position.y < before.nodes.get('done')!.position.y)
})

test('comparison sides share canonical node slots and keep changed edge identities separate', () => {
  const beforeNodes = [node('a'), node('b'), node('removed')]
  const afterNodes = [node('added'), node('b', '新增说明。'.repeat(15)), node('a')]
  const beforeEdges = [edge('same', 'a', 'b'), edge('retargeted', 'b', 'removed')]
  const afterEdges = [edge('same', 'a', 'b'), edge('retargeted', 'b', 'added')]
  const original = structuredClone({ beforeNodes, afterNodes, beforeEdges, afterEdges })
  const before = comparisonLayout(beforeNodes, beforeEdges, afterNodes, afterEdges,
    new Map(beforeNodes.map(item => [item.id, { width: 248, height: 100 }])))
  const after = comparisonLayout(afterNodes, afterEdges, beforeNodes, beforeEdges,
    new Map(afterNodes.map(item => [item.id, { width: 248, height: 140 }])))
  for (const id of ['a', 'b']) assert.deepEqual(before.nodes.get(id)!.position, after.nodes.get(id)!.position)
  assert.deepEqual([...before.edges.keys()], beforeEdges.map(item => item.id))
  assert.deepEqual([...after.edges.keys()], afterEdges.map(item => item.id))
  assert.notEqual(before.edges.get('retargeted')!.targetHandle, after.edges.get('retargeted')!.targetHandle)
  const local = comparisonLayout(beforeNodes.slice(0, 2), beforeEdges.slice(0, 1), afterNodes.slice(1), afterEdges.slice(0, 1), new Map())
  assert.equal(local.edges.get('same')!.sourceHandle, before.edges.get('same')!.sourceHandle)
  assert.equal(local.edges.get('same')!.targetHandle, before.edges.get('same')!.targetHandle)
  for (const [result, definitions] of [[before, beforeEdges], [after, afterEdges]] as const) {
    for (const item of definitions) {
      const route = result.edges.get(item.id)!
      for (const [id, handle, point] of [[item.source, route.sourceHandle, route.points[0]], [item.target, route.targetHandle, route.points.at(-1)!]] as const) {
        const placed = result.nodes.get(id)!
        const port = placed.ports.find(port => port.id === handle)!
        assert(port)
        assert.equal(point.x, placed.position.x + (port.side === 'top' || port.side === 'bottom' ? port.offset : port.side === 'left' ? 0 : placed.width))
        assert.equal(point.y, placed.position.y + (port.side === 'left' || port.side === 'right' ? port.offset : port.side === 'top' ? 0 : placed.height))
      }
    }
  }
  assert.deepEqual({ beforeNodes, afterNodes, beforeEdges, afterEdges }, original)
})

test('collapsed cyclic comparison imports retain valid union routes and actual boundary ports', () => {
  const afterNodes = ['start', 'guard', 'read', 'collect', 'choose', 'upload', 'finish', 'done', 'failed', 'stale'].map(id => ({
    ...node(id, `核对 ${id} 的当前业务规则。`),
    kind: id === 'failed' ? 'failure' as const : id === 'stale' || id === 'done' ? 'result' as const : 'action' as const,
  }))
  const pairs = [
    ['start-guard', 'start', 'guard', '开始调度'], ['guard-read', 'guard', 'read', '有效读取'],
    ['guard-upload', 'guard', 'upload', '有效上传'], ['guard-finish', 'guard', 'finish', '有效收尾'],
    ['read-collect', 'read', 'collect', '处理有效记录'], ['read-failed', 'read', 'failed', '来源读取失败'],
    ['read-stale', 'read', 'stale', '读取回执过期'], ['collect-guard', 'collect', 'guard', '继续下一来源'],
    ['collect-choose', 'collect', 'choose', '全部来源读取完成'], ['choose-guard', 'choose', 'guard', '调度上传'],
    ['choose-empty', 'choose', 'guard', '无候选直接收尾'], ['upload-guard', 'upload', 'guard', '处理上传回执'],
    ['finish-done', 'finish', 'done', '完成'], ['finish-failed', 'finish', 'failed', '收尾失败'],
    ['finish-stale', 'finish', 'stale', '收尾回执过期'],
  ]
  const afterEdges = pairs.map(([id, source, target, label]) => ({ ...edge(id, source, target), label }))
  const beforeNodes = afterNodes.filter(item => item.id !== 'choose')
  const beforeEdges = afterEdges.filter(item => item.source !== 'choose' && item.target !== 'choose')
  const original = structuredClone({ beforeNodes, beforeEdges, afterNodes, afterEdges })
  for (const heights of [[160, 160], [108, 140]]) {
    const before = comparisonLayout(beforeNodes, beforeEdges, afterNodes, afterEdges,
      new Map(beforeNodes.map(item => [item.id, { width: 248, height: heights[0] }])))
    const after = comparisonLayout(afterNodes, afterEdges, beforeNodes, beforeEdges,
      new Map(afterNodes.map(item => [item.id, { width: 248, height: heights[1] }])))
    for (const item of beforeNodes) assert.deepEqual(before.nodes.get(item.id)!.position, after.nodes.get(item.id)!.position)
    for (const [result, definitions] of [[before, beforeEdges], [after, afterEdges]] as const) {
      assert.deepEqual([...result.edges.keys()], definitions.map(item => item.id))
      for (const item of definitions) {
        const route = result.edges.get(item.id)!
        assert.ok([...route.points, route.label].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
        for (const [id, handle, point] of [[item.source, route.sourceHandle, route.points[0]], [item.target, route.targetHandle, route.points.at(-1)!]] as const) {
          const placed = result.nodes.get(id)!, port = placed.ports.find(item => item.id === handle)!
          assert.ok(port)
          assert.equal(point.x, placed.position.x + (port.side === 'top' || port.side === 'bottom' ? port.offset : port.side === 'left' ? 0 : placed.width))
          assert.equal(point.y, placed.position.y + (port.side === 'left' || port.side === 'right' ? port.offset : port.side === 'top' ? 0 : placed.height))
        }
      }
    }
  }
  assert.deepEqual({ beforeNodes, beforeEdges, afterNodes, afterEdges }, original)
})
