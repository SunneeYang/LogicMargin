import type { ReviewComment, ReviewDocument, ReviewEdge, ReviewNode, Target } from './types.ts'

export const targetKey = (target: Target) => `${target.kind}:${target.id}`

export function indexGraph(nodes: ReviewNode[], edges: ReviewEdge[], scenes: ReviewDocument['scenes']) {
  const nodesById = new Map<string, ReviewNode>()
  const edgesById = new Map<string, ReviewEdge>()
  const nodesByScene = new Map<string, ReviewNode[]>()
  const edgesByScene = new Map<string, ReviewEdge[]>()
  const targetScenes = new Map<string, string>()
  const failureIds = new Set<string>()
  const branchSources = new Set<string>()
  for (const scene of scenes) targetScenes.set(`scene:${scene.id}`, scene.id)
  for (const node of nodes) {
    nodesById.set(node.id, node)
    const group = nodesByScene.get(node.sceneId) ?? []
    group.push(node)
    nodesByScene.set(node.sceneId, group)
    targetScenes.set(`node:${node.id}`, node.sceneId)
    if (node.kind === 'failure') failureIds.add(node.id)
  }
  for (const edge of edges) {
    edgesById.set(edge.id, edge)
    const group = edgesByScene.get(edge.sceneId) ?? []
    group.push(edge)
    edgesByScene.set(edge.sceneId, group)
    targetScenes.set(`edge:${edge.id}`, edge.sceneId)
    if (failureIds.has(edge.target)) branchSources.add(edge.source)
  }
  return { nodesById, edgesById, nodesByScene, edgesByScene, targetScenes, failureIds, branchSources }
}

export function indexGraphComments(comments: ReviewComment[], targetScenes: ReadonlyMap<string, string>) {
  const counts = new Map<string, number>()
  const latest = new Map<string, string>()
  const numbers = new Map<string, number>()
  const multiObjectByScene = new Map<string, ReviewComment[]>()
  comments.forEach((comment, index) => {
    numbers.set(comment.id, index + 1)
    const targets = new Set(comment.targets.map(targetKey))
    const scenes = new Set<string>()
    for (const key of targets) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      latest.set(key, comment.id)
      const scene = targetScenes.get(key)
      if (scene !== undefined) scenes.add(scene)
    }
    if (targets.size < 2) return
    for (const scene of scenes) {
      const group = multiObjectByScene.get(scene) ?? []
      group.push(comment)
      multiObjectByScene.set(scene, group)
    }
  })
  return { counts, latest, numbers, multiObjectByScene }
}
