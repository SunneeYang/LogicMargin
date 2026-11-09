import { sampleReview } from '../../../src/sample.ts'

const node = (id, x = 0, y = 0, kind = 'action') => ({ id, kind, position: { x, y }, title: id, summary: '' })
const edge = (id, source, target, label = id) => ({ id, source, target, label })
const input = (nodes, edges, sizes = [], reference) => ({ nodes, edges, sizes, ...(reference ? { reference } : {}) })

export function layoutCases() {
  const cases = [{ name: 'empty', input: input([], []), authored: false },
    { name: 'single', input: input([node('single')], []), authored: false }]
  const nodes = sampleReview.nodes.map(({ id, kind, position, title, summary }) => ({ id, kind, position, title, summary }))
  const edges = sampleReview.edges.map(({ id, source, target, label }) => ({ id, source, target, label }))
  for (const scene of sampleReview.scenes) {
    const ids = new Set(sampleReview.nodes.filter(item => item.sceneId === scene.id).map(item => item.id))
    cases.push({ name: `sample-${scene.id}`, input: input(nodes.filter(item => ids.has(item.id)), edges.filter(item => ids.has(item.source))), authored: true })
  }
  cases.push({ name: 'sample-all-scenes', input: input(nodes, edges), authored: false })
  const beforeLanes = [node('a', 0, 0), node('b', 0, 360), node('c', 600, 360)]
  const afterLanes = [node('a', 0, 0), node('b', 600, 360), node('c', 0, 360)]
  const laneEdges = [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]
  cases.push({ name: 'comparison-swapped-lanes', input: input(beforeLanes, laneEdges, [], { nodes: afterLanes, edges: laneEdges }), authored: false })
  cases.push({ name: 'authored-bypass-and-same-row-branch', input: input(
    [node('a', 0, 0), node('b', 0, 300), node('c', 0, 600), node('branch', 600, 300)],
    [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('skip', 'a', 'c'), edge('branch', 'b', 'branch'), edge('return', 'c', 'b'), edge('self', 'branch', 'branch')],
  ), authored: true })
  cases.push({ name: 'authored-simple-return-corner', input: input(
    [node('station', 512, 0), node('branch', 0, 600), node('guard', 512, 600)],
    [edge('a', 'guard', 'branch', '继续'), edge('b', 'branch', 'station', '继续')],
  ), authored: true })
  for (const offset of [0, 420, .125]) {
    const before = [node('old', 0, 0), node('work', 0, 210), node('done', 0, 420, 'result')]
    const after = [node('new', 600, offset), node('work', 600, 210 + offset, 'decision'), node('done', 600, 420 + offset)]
    const oldEdges = [edge('start', 'old', 'work'), edge('finish', 'work', 'done')]
    const newEdges = [edge('start', 'new', 'work'), edge('finish', 'work', 'done')]
    cases.push({ name: `comparison-rigid-${offset}-B-R`, input: input(before, oldEdges, [], { nodes: after, edges: newEdges }), authored: true })
    cases.push({ name: `comparison-rigid-${offset}-R-B`, input: input(after.toReversed(), newEdges, [], { nodes: before.toReversed(), edges: oldEdges }), authored: true })
  }
  const fractionalBefore = [node('old', .1, -210), node('work', .1, 0), node('done', .1, 210)]
  const fractionalAfter = [node('new', .1, -210), node('work', 1e7, 0), node('done', 1e7, 210)]
  const fractionalOldEdges = [edge('start', 'old', 'work'), edge('finish', 'work', 'done')]
  const fractionalNewEdges = [edge('start', 'new', 'work'), edge('finish', 'work', 'done')]
  cases.push({ name: 'comparison-inexact-translation', input: input(fractionalBefore, fractionalOldEdges, [], { nodes: fractionalAfter, edges: fractionalNewEdges }), authored: false })
  const authoredNodes = [node('a', 0, 0), node('b', 0, 300, 'decision'), node('c', 480, 600, 'result'), node('d', 960, 300, 'failure')]
  const authoredEdges = [edge('forward', 'a', 'b'), edge('complete', 'b', 'c'), edge('fail', 'b', 'd'), edge('return', 'b', 'a'), edge('self', 'a', 'a')]
  cases.push({ name: 'authored-return-exception-self', input: input(authoredNodes, authoredEdges), authored: true })
  cases.push({ name: 'dagre-return-exception-self', input: input(authoredNodes.map(item => ({ ...item, position: { x: 0, y: 0 } })), authoredEdges), authored: false })
  const fanNodes = [node('hub'), ...Array.from({ length: 12 }, (_, i) => node(`fan-${i}`))]
  const fanEdges = fanNodes.slice(1).flatMap((item, i) => [edge(`out-${i}`, 'hub', item.id), edge(`in-${i}`, item.id, 'hub')])
  cases.push({ name: 'dagre-high-fan-in-out', input: input(fanNodes, fanEdges), authored: false })
  cases.push({ name: 'authored-high-fan-in-out', input: input(fanNodes.map((item, i) => ({ ...item, position: { x: 0, y: i * 300 } })), fanEdges), authored: true })
  const sized = authoredNodes.map((item, i) => ({ id: item.id, width: 248.125 + i * .375, height: 160.75 + i * .125 }))
  cases.push({ name: 'authored-fractional-sizes-long-labels', input: input(authoredNodes, authoredEdges.map(item => ({ ...item, label: '长条件😀é abc\n'.repeat(14) })), sized), authored: true })
  cases.push({ name: 'dagre-fractional-sizes-long-labels', input: input(authoredNodes.map(item => ({ ...item, position: { x: 0, y: 0 } })), authoredEdges.map(item => ({ ...item, label: '长条件😀é abc\n'.repeat(14) })), sized), authored: false })
  for (const authored of [false, true]) {
    const beforeNodes = [node('a', 0, 0), node('b', 0, authored ? 300 : 0), node('removed', authored ? 480 : 0, authored ? 600 : 0)]
    const afterNodes = [node('added', authored ? 960 : 0, authored ? 600 : 0),
      { ...node('b', 0, authored ? 300 : 0, 'decision'), title: 'changed title '.repeat(20), summary: '新增说明😀。'.repeat(60) }, node('a')]
    const beforeEdges = [edge('same', 'a', 'b', 'old'), edge('redirect', 'b', 'removed')]
    const afterEdges = [edge('same', 'a', 'b', 'longer label'), edge('redirect', 'b', 'added')]
    for (const swapped of [false, true]) {
      const [currentNodes, currentEdges, referenceNodes, referenceEdges] = swapped
        ? [afterNodes, afterEdges, beforeNodes, beforeEdges] : [beforeNodes, beforeEdges, afterNodes, afterEdges]
      cases.push({ name: `comparison-${authored ? 'authored' : 'dagre'}-${swapped ? 'R-B' : 'B-R'}`,
        input: input(currentNodes, currentEdges, currentNodes.map((item, i) => ({ id: item.id, width: 248.125, height: 120.5 + i })), { nodes: referenceNodes, edges: referenceEdges }), authored })
    }
  }
  for (const ids of [
    ['a', 'A', 'á', 'ä', 'é', 'e\u0301', '中', '文', '😀', '🚀'],
    ['quote"\\\n', '\u2028', "'); throw Error('injected');//"],
    ['__proto__', 'constructor', 'toString'],
    ['💩', '🫠', '😀', '中'],
  ]) {
    const unicodeNodes = ids.map(id => node(id))
    const unicodeEdges = ids.slice(1).map((id, i) => edge(`edge:${id}`, ids[0], id))
    cases.push({ name: ids.includes('🫠') ? 'comparison-modern-emoji' : ids.includes('__proto__') ? 'comparison-reserved-ids-error' : ids.includes('\u2028') ? 'comparison-escaped-ids' : 'comparison-unicode-ids',
      input: input(unicodeNodes, unicodeEdges, [], { nodes: [...unicodeNodes].reverse(), edges: [] }), authored: false, expectedFailure: ids.includes('__proto__') })
  }
  cases.push({ name: 'large-45-authored', input: largeLayoutCase(45, true), authored: true })
  cases.push({ name: 'large-45-dagre', input: largeLayoutCase(45, false), authored: false })
  return cases
}

export function largeLayoutCase(count = 45, authored = true) {
  const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`, authored ? (i % 5) * 480 : 0, authored ? Math.floor(i / 5) * 300 : 0))
  const edges = nodes.slice(5).map((item, i) => edge(`e${i}`, nodes[i].id, item.id, `condition ${i}`))
  return input(nodes, edges)
}
