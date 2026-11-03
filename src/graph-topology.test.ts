import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutGraph } from './graph-layout.ts'
import type { LayoutPoint } from './graph-layout.ts'
import type { ReviewEdge, ReviewNode } from './types.ts'

function crosses(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
  const determinant = rx * sy - ry * sx
  if (Math.abs(determinant) < 1e-9) return false
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / determinant
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / determinant
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
}

test('shared rejection exits do not cross the normal branch or change review identities', () => {
  const definitions: [string, ReviewNode['kind']][] = [
    ['start', 'action'], ['check', 'decision'], ['quota', 'decision'], ['rejected', 'failure'],
    ['execute', 'action'], ['advance', 'action'], ['ready', 'decision'], ['pending', 'result'], ['done', 'result'],
  ]
  const nodes: ReviewNode[] = definitions.map(([id, kind]) => ({
    id, kind, sceneId: 'scene', title: id, summary: '', detail: '', input: '', output: '',
    position: { x: 0, y: 0 }, evidence: [],
  }))
  const transitions = [
    ['start', 'check', ''], ['check', 'quota', '通过'], ['check', 'rejected', '拒绝'],
    ['quota', 'rejected', '不符'], ['quota', 'execute', '符合'], ['execute', 'advance', ''],
    ['advance', 'ready', '核对结果'], ['ready', 'pending', '未完成'], ['ready', 'done', '所有校验已通过'],
  ]
  const edges: ReviewEdge[] = transitions.map(([source, target, label]) => ({
    id: `${source}-${target}`, source, target, label, sceneId: 'scene', detail: '',
  }))
  const original = structuredClone({ nodes, edges })
  for (const measured of [false, true]) {
    const sizes = new Map(measured ? nodes.map((node, index) => [
      node.id, { width: index % 2 ? 320 : 248, height: [128, 160, 224][index % 3] },
    ] as const) : [])
    const layout = layoutGraph(nodes, edges, sizes)
    const rejected = layout.edges.get('quota-rejected')!.points
    const normal = layout.edges.get('quota-execute')!.points
    for (let one = 1; one < rejected.length; one++) {
      for (let two = 1; two < normal.length; two++) {
        assert.equal(crosses(rejected[one - 1], rejected[one], normal[two - 1], normal[two]), false,
          `the rejection branch crosses the normal branch (${measured ? 'measured' : 'default'})`)
      }
    }
    assert.deepEqual([...layout.nodes.keys()], nodes.map(node => node.id))
    assert.deepEqual([...layout.edges.keys()], edges.map(edge => edge.id))
    assert.deepEqual(layoutGraph(nodes, edges, sizes), layout)
    assert.deepEqual({ nodes, edges }, original)
  }
})
