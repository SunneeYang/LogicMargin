import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexGraph, indexGraphComments } from './graph-index.ts'
import { sampleReview } from './sample.ts'
import type { ReviewComment, Target } from './types.ts'

const scenes = [{ id: 'a', title: 'A', description: '' }, { id: 'b', title: 'B', description: '' }, { id: 'empty', title: 'Empty', description: '' }]
const nodes = [
  { ...sampleReview.nodes[0], id: 'shared', sceneId: 'a' },
  { ...sampleReview.nodes[1], id: 'node-b', sceneId: 'b' },
  { ...sampleReview.nodes[0], id: 'failure-a', sceneId: 'a', kind: 'failure' as const },
]
const edges = [
  { id: 'shared', sceneId: 'b', source: 'node-b', target: 'node-b', label: 'B', detail: '' },
  { id: 'failure-edge', sceneId: 'a', source: 'shared', target: 'failure-a', label: '拒绝', detail: '' },
]
const comment = (id: string, targets: Target[]): ReviewComment => ({ id, body: id, targets, status: 'open',
  createdAt: '2026-11-03T00:00:00Z', revision: 'r1' })

test('graph index keeps target kinds distinct, source order, empty scenes and failure branches', () => {
  const graph = indexGraph(nodes, edges, scenes)
  assert.equal(graph.targetScenes.get('node:shared'), 'a')
  assert.equal(graph.targetScenes.get('edge:shared'), 'b')
  assert.equal(graph.targetScenes.get('scene:empty'), 'empty')
  assert.equal(graph.targetScenes.get('review:review-id'), undefined)
  assert.equal(graph.nodesById.get('shared'), nodes[0])
  assert.equal(graph.edgesById.get('shared'), edges[0])
  assert.deepEqual(graph.nodesByScene.get('a'), [nodes[0], nodes[2]])
  assert.deepEqual(graph.edgesByScene.get('b'), [edges[0]])
  assert.deepEqual([...graph.failureIds], ['failure-a'])
  assert.deepEqual([...graph.branchSources], ['shared'])
})

test('multi-target comments count each target and each scene once while preserving thread order and numbers', () => {
  const graph = indexGraph(nodes, edges, scenes)
  const crossScene = comment('cross-scene', [{ kind: 'node', id: 'shared' }, { kind: 'edge', id: 'shared' }, { kind: 'scene', id: 'a' }])
  const sameScene = comment('same-scene', [{ kind: 'node', id: 'shared' }, { kind: 'node', id: 'shared' }, { kind: 'node', id: 'failure-a' }])
  const missing = comment('deleted-only', [{ kind: 'node', id: 'gone' }, { kind: 'edge', id: 'gone' }])
  const partial = comment('partly-deleted', [{ kind: 'node', id: 'gone' }, { kind: 'node', id: 'shared' }])
  const wholeReview = comment('whole-review', [{ kind: 'review', id: 'review-id' }])
  const index = indexGraphComments([crossScene, sameScene, missing, partial, wholeReview], graph.targetScenes)
  assert.equal(index.counts.get('node:shared'), 3)
  assert.equal(index.counts.get('node:gone'), 2)
  assert.equal(index.counts.get('edge:gone'), 1)
  assert.equal(index.latest.get('node:shared'), partial.id)
  assert.equal(index.latest.get('edge:shared'), crossScene.id)
  assert.deepEqual(index.multiObjectByScene.get('a'), [crossScene, sameScene, partial])
  assert.deepEqual(index.multiObjectByScene.get('b'), [crossScene])
  assert.equal(index.multiObjectByScene.get('empty'), undefined)
  assert.deepEqual([...index.numbers], [[crossScene.id, 1], [sameScene.id, 2], [missing.id, 3], [partial.id, 4], [wholeReview.id, 5]])
})

test('duplicate anchors do not multiply markers and removed anchors never attach to an unrelated scene', () => {
  const duplicate = comment('duplicate', [{ kind: 'node', id: 'shared' }, { kind: 'node', id: 'shared' }])
  const mixed = comment('mixed', [{ kind: 'node', id: 'shared' }, { kind: 'scene', id: 'empty' }])
  const original = indexGraph(nodes, edges, scenes)
  const single = indexGraphComments([duplicate], original.targetScenes)
  assert.equal(single.counts.get('node:shared'), 1)
  assert.equal(single.multiObjectByScene.size, 0)
  const before = indexGraphComments([duplicate, mixed], original.targetScenes)
  assert.equal(before.counts.get('node:shared'), 2)
  assert.deepEqual(before.multiObjectByScene.get('a'), [mixed])
  assert.deepEqual(before.multiObjectByScene.get('empty'), [mixed])
  const removed = indexGraph(nodes.slice(1), edges.slice(0, 1), scenes)
  const after = indexGraphComments([duplicate, mixed], removed.targetScenes)
  assert.equal(after.counts.get('node:shared'), 2)
  assert.equal(after.multiObjectByScene.get('a'), undefined)
  assert.equal(after.multiObjectByScene.get('b'), undefined)
  assert.deepEqual(after.multiObjectByScene.get('empty'), [mixed])
  assert.deepEqual(indexGraphComments([duplicate, mixed], original.targetScenes).multiObjectByScene.get('a'), [mixed])
})
