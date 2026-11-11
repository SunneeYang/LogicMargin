// Generate additional V8 geometry fixtures from the explicit source worktree.
// Usage: node native-layout-oracle.mjs /absolute/path/to/source-worktree
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.argv[2]) throw new Error('Pass the source worktree explicitly')
const root = resolve(process.argv[2])
const sources = ['src/graph-precompute-entry.ts', 'src/graph-layout.ts', 'src/graph-routing.ts', 'src/graph-focus.ts', 'src/graph-label.ts', 'src/graph-order.ts']
async function fingerprint() {
  const hash = createHash('sha256')
  for (const path of sources) hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0')
  return hash.digest('hex')
}
const sourceSHA = await fingerprint()
const { layoutGraph } = await import(pathToFileURL(join(root, 'src/graph-layout.ts')))
const { comparisonLayout } = await import(pathToFileURL(join(root, 'src/graph-focus.ts')))
const { compareGraphIds } = await import(pathToFileURL(join(root, 'src/graph-order.ts')))
const { measureEdgeLabel } = await import(pathToFileURL(join(root, 'src/graph-label.ts')))
const node = (id, x, y, kind = 'action', title = id, summary = '') => ({ id, kind, position: { x, y }, title, summary })
const edge = (id, source, target, label = id) => ({ id, source, target, label })
const cases = []
function add(name, nodes, edges, sizes = [], reference, authored = true) {
  cases.push({ name, input: { nodes, edges, sizes, ...(reference ? { reference } : {}) }, authored })
}
const special = ['a', 'A', 'á', 'e\u0301', '中', '😀', '💩', '\ue000', '\uffff', '🫠', '&<>', `"'()\\\n\b\f\r\t\u0002`, '\u2028\u2029']
const hub = node('hub', 0, 0, 'decision')
const exits = special.slice(0, 9).map((id, i) => node(id, 480 + i * 480, 300, i % 3 === 0 ? 'failure' : 'result'))
const fanEdges = exits.flatMap((item, i) => [edge(`出口${special[i]}`, 'hub', item.id, 'if 😀中文 é\n' + 'long condition '.repeat(i)), edge(`反馈${special[8 - i]}`, item.id, 'hub')])
add('nine-exits-feedback-self', [hub, ...exits], [...fanEdges, edge('self1', 'hub', 'hub'), edge('self2', 'hub', 'hub')])
const mixed = special.map((id, i) => node(id, i % 4 * 480, Math.floor(i / 4) * 300, ['action', 'decision', 'result', 'failure'][i % 4], '😀'.repeat(43) + '\n' + id, '🫠'.repeat(53) + '\n中文é'))
const mixedEdges = mixed.slice(1).flatMap((item, i) => [edge(`same-${special[i]}`, mixed[0].id, item.id, 'a\n\n中文😀' + 'a'.repeat(i * 9)), edge(`in-${special[i]}`, item.id, mixed[(i + 2) % mixed.length].id)])
const sizes = mixed.map((item, i) => ({ id: item.id, width: 190.125 + i * 1.375, height: 100.75 + i * .125 }))
add('unicode-fractional-routing', mixed, mixedEdges, sizes)
const afterNodes = [...mixed.slice(2).reverse().map((item, i) => ({ ...item, kind: i % 2 ? 'decision' : 'action', title: 'title'.repeat(i), summary: '😀'.repeat(70 - i) })), node('added', 2400, 1500)]
const afterEdges = [edge(mixedEdges[0].id, mixed[2].id, mixed[3].id, 'redirect'), ...mixedEdges.filter(item => afterNodes.some(n => n.id === item.source) && afterNodes.some(n => n.id === item.target)), edge('new &<>"()', mixed[3].id, 'added', '😀'.repeat(75))]
for (const [name, nodes, edges, refNodes, refEdges] of [['B-R', mixed, mixedEdges, afterNodes, afterEdges], ['R-B', afterNodes, afterEdges, mixed, mixedEdges]]) {
  add(`comparison-${name}`, nodes, edges, sizes.filter(size => [...nodes, ...refNodes].some(item => item.id === size.id)), { nodes: refNodes, edges: refEdges })
  add(`comparison-empty-visible-${name}`, [], [], [], { nodes, edges })
}
const equalNodes = [node('start', 0, 0), node('end', 0, 300)]
const movedBefore = [node('a', 960, 900), node('b', 0, 0), node('removed', 480, 300)]
const movedAfter = [node('b', 960, 0), node('a', 0, 600), node('added', 1440, 900, 'failure')]
const movedBeforeEdges = [edge('same', 'b', 'a'), edge('redirect', 'a', 'removed')]
const movedAfterEdges = [edge('same', 'b', 'a'), edge('redirect', 'a', 'added')]
for (const [name, nodes, edges, refNodes, refEdges] of [['B-R', movedBefore, movedBeforeEdges, movedAfter, movedAfterEdges], ['R-B', movedAfter, movedAfterEdges, movedBefore, movedBeforeEdges]]) {
  add(`comparison-moved-${name}`, nodes, edges, [{ id: 'a', width: 248.125, height: 160.75 }, { id: 'b', width: 300.375, height: 200.125 }], { nodes: refNodes, edges: refEdges })
}
for (const [label, other] of [['😀😀', 'aaaa'], ['&<>', '"()'], ['😀a', 'bbb'], ['z', 'a']]) {
  const before = [edge('key &<>"()😀', 'start', 'end', label)]
  const after = [edge('key &<>"()😀', 'start', 'end', other)]
  add(`comparison-label-${JSON.stringify([label, other])}`, equalNodes, before, [], { nodes: equalNodes, edges: after })
}
for (const [name, nodes, edges, reference] of [
  ['empty', [], []], ['single', [hub], []],
  ['overlap', [hub, node('other', 247, 159)], []],
  ['cycle-dagre', [hub, node('other', 0, 0)], [edge('forward', 'hub', 'other'), edge('back', 'other', 'hub')]],
  ['comparison-single', [hub], [], { nodes: [hub], edges: [] }],
  ['comparison-empty', [], [], { nodes: [], edges: [] }],
]) add(name, nodes, edges, [], reference, false)
add('touching-baseline-boxes', [hub, node('other', 248, 0)], [edge('forward', 'hub', 'other')])
add('missing-endpoint', equalNodes, [edge('invalid', 'start', 'missing')])
// Deterministic, small graphs exercise route tie breaking without changing the oracle's source algorithm.
let randomState = 0x20261109
const random = () => ((randomState = Math.imul(randomState, 1664525) + 1013904223 >>> 0) / 2 ** 32)
for (let sample = 0; sample < 30; sample++) {
  const count = 3 + sample % 7
  const nodes = special.slice(0, count).map((id, i) => node(id, i % 3 * 480, Math.floor(i / 3) * 300, ['action', 'decision', 'result', 'failure'][Math.floor(random() * 4)]))
  const edges = Array.from({ length: 2 + sample % 13 }, (_, i) => edge(`e:${special[i % special.length]}:${i}`, nodes[Math.floor(random() * count)].id, nodes[Math.floor(random() * count)].id, ['ok', '条件😀', 'long '.repeat(20), '\n'][i % 4]))
  add(`generated-${sample}`, nodes, edges, nodes.map(item => ({ id: item.id, width: 248.125 + random() * 2, height: 160.75 + random() * 2 })))
}
const output = []
const { layoutCases } = await import(pathToFileURL(join(root, 'internal/precompute/testdata/layout-cases.mjs')).href)
cases.push(...layoutCases().filter(fixture => fixture.name.startsWith('comparison-disjoint-') || fixture.name.startsWith('compact-') || fixture.name.startsWith('joined-')))
for (const fixture of cases) {
  const { name, input, authored } = fixture
  const measured = new Map(input.sizes.map(({ id, width, height }) => [id, { width, height }]))
  try {
    const result = input.reference ? comparisonLayout(input.nodes, input.edges, input.reference.nodes, input.reference.edges, measured) : layoutGraph(input.nodes, input.edges, measured)
    output.push({ name, input, expected: { nodes: Object.fromEntries(result.nodes), edges: Object.fromEntries(result.edges), usesAuthoredPositions: authored } })
  } catch (error) { output.push({ name, input, authored, expectedError: String(error) }) }
}
if (sourceSHA !== await fingerprint()) throw new Error('Sources changed while generating fixtures; retry')
const ids = [...special, '__proto__', 'constructor', 'toString']
const oracle = { sources: sourceSHA, node: process.versions.node,
  collation: ids.flatMap(a => ids.map(b => ({ a, b, sign: compareGraphIds(a, b) }))),
  identities: ids.map(id => { const edge = { id, source: `source:${id}`, target: `target:${id}` }; const json = JSON.stringify([edge.id, edge.source, edge.target]); return { edge, json, uri: encodeURIComponent(json) } }),
  labels: ['', 'a'.repeat(27), '😀'.repeat(16), 'éÿĀ中', '\n\n', 'long 中文😀 label\n'.repeat(20)].map(text => ({ text, ...measureEdgeLabel(text) })),
  cases: output }
await writeFile(new URL('./native-layout-oracle.json', import.meta.url), `${JSON.stringify(oracle)}\n`)
console.log(JSON.stringify({ sources: sourceSHA, cases: output.length, errors: output.filter(item => item.expectedError).map(item => item.name) }))
