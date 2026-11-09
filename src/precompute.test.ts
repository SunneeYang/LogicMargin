import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Chunk, diff, presentableDiff } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { createPrecomputeClient, layoutInput, sourceReference, validDiff } from './precompute.ts'
import type { ComputedDiff, DiffInput, LayoutInput } from './precompute.ts'
import { buildUnifiedDiff, codeDiffConfig } from './unified-code-diff.ts'
import { sampleReview } from './sample.ts'

const caps = { schemaVersion: 1, coordinate: 'utf16', diffAlgorithm: 'diff-v1', layoutAlgorithm: 'layout-bundle-v1' }
const reference = { path: 'saved.go', symbol: 'saved', startLine: 2, endLine: 4, digest: 'old-digest' }
const input: DiffInput = { beforeSnapshot: { kind: 'baseline' }, afterSnapshot: { kind: 'round', round: 2 },
  before: reference, after: { ...reference, digest: 'new-digest' } }
const result = (key = 'diff-key'): ComputedDiff => ({ schemaVersion: 1, algorithm: caps.diffAlgorithm, key, coordinate: 'utf16', language: 'go',
  before: { digest: input.before.digest, length: 3 }, after: { digest: input.after.digest, length: 3 }, precise: true,
  changes: [{ fromA: 1, toA: 2, fromB: 1, toB: 2 }] })
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('hanging capability and computation requests time out into local fallback', async t => {
  for (const hanging of ['capabilities', 'computation']) {
    const timeout = new AbortController()
    const deadlines: number[] = []
    const patched = t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return timeout.signal })
    const client = createPrecomputeClient(async (url, options) => {
      if (hanging === 'computation' && String(url) === '/api/precompute') return response(caps)
      return new Promise<Response>((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
    })
    const waiting = client.layout('saved', { nodes: [], edges: [], sizes: [] })
    await tick()
    timeout.abort(new DOMException('Timed out', 'TimeoutError'))
    assert.equal(await waiting, null)
    assert.deepEqual(deadlines, hanging === 'capabilities' ? [2000] : [2000, 8000])
    patched.mock.restore()
  }
})

test('local imports never probe capabilities or upload; old Node and offline services fall back', async () => {
  let calls = 0
  const client = createPrecomputeClient(async () => { calls++; return new Response('', { status: 404 }) })
  assert.equal(await client.diff(undefined, input, 'abc', 'axc'), null)
  assert.equal(await client.layout(undefined, { nodes: [], edges: [], sizes: [] }), null)
  assert.equal(calls, 0)
  assert.equal(await client.diff('saved', input, 'abc', 'axc'), null)
  assert.equal(await client.diff('saved', input, 'abc', 'axc'), null)
  assert.equal(calls, 1)
  assert.equal(await createPrecomputeClient(async () => { throw new TypeError('Offline') }).diff('saved', input, 'abc', 'axc'), null)
})

test('diff POST uses stored selectors and references, validates versions and reuses one in-flight request', async () => {
  const requests: { path: string; body: unknown }[] = []
  let finish!: (value: Response) => void
  const client = createPrecomputeClient(async (url, options) => {
    requests.push({ path: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined })
    return String(url) === '/api/precompute' ? response(caps) : new Promise(resolve => { finish = resolve })
  })
  const a = new AbortController(), b = new AbortController()
  const first = client.diff('a/b', input, 'abc', 'axc', a.signal)
  const rejected = assert.rejects(first, { name: 'AbortError' })
  const second = client.diff('a/b', input, 'abc', 'axc', b.signal)
  await tick()
  a.abort()
  finish(response(result()))
  await rejected
  assert.deepEqual(await second, result())
  assert.deepEqual(await client.diff('a/b', input, 'abc', 'axc'), result())
  assert.deepEqual(requests, [{ path: '/api/precompute', body: undefined },
    { path: '/api/review-sessions/a%2Fb/precompute/diff', body: input }])
  assert.ok(!JSON.stringify(requests).includes('abc'))
  const invalid = createPrecomputeClient(async url => response(String(url) === '/api/precompute' ? caps : { ...result(), key: '', algorithm: 'other' }))
  assert.equal(await invalid.diff('saved', input, 'abc', 'axc'), null)
})

test('last cancellation aborts HTTP and a late response cannot seed the cache', async () => {
  let finish!: (value: Response) => void, signal: AbortSignal | undefined, posts = 0
  const client = createPrecomputeClient(async (url, options) => {
    if (String(url) === '/api/precompute') return response(caps)
    posts++; signal = options?.signal ?? undefined
    return new Promise(resolve => { finish = resolve })
  })
  const controller = new AbortController()
  const waiting = client.diff('saved', input, 'abc', 'axc', controller.signal)
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  await tick(); controller.abort(); await rejected
  assert.equal(signal?.aborted, true)
  finish(response(result('late')))
  await tick()
  const next = client.diff('saved', input, 'abc', 'axc')
  await tick(); finish(response(result('fresh')))
  assert.equal((await next)?.key, 'fresh')
  assert.equal(posts, 2)
})

test('LRU has a finite entry and byte budget', async () => {
  let posts = 0
  const client = createPrecomputeClient(async url => {
    if (String(url) === '/api/precompute') return response(caps)
    posts++; return response(result())
  })
  for (let i = 0; i < 55; i++) await client.diff(`session-${i}`, input, 'abc', 'axc')
  await client.diff('session-54', input, 'abc', 'axc')
  assert.equal(posts, 55)
  await client.diff('session-0', input, 'abc', 'axc')
  assert.equal(posts, 56)
  const large = { ...input, before: { ...reference, path: 'a'.repeat(4_300_000) } }
  await client.diff('huge', large, 'abc', 'axc')
  await client.diff('huge', large, 'abc', 'axc')
  assert.equal(posts, 58)
})

test('diff validation rejects wrong digests, gaps, offsets, surrogate cuts and absent algorithm keys', () => {
  assert.ok(validDiff(result(), caps.diffAlgorithm, input, 'abc', 'axc'))
  for (const invalid of [{ ...result(), algorithm: '' }, { ...result(), key: '' }, { ...result(), coordinate: 'utf8' },
    { ...result(), changes: [] }, { ...result(), before: { digest: 'wrong', length: 3 } },
    { ...result(), changes: [{ fromA: -1, toA: 2, fromB: 1, toB: 2 }] }]) {
    assert.equal(validDiff(invalid, caps.diffAlgorithm, input, 'abc', 'axc'), false)
  }
  const unicode = { ...result(), before: { digest: input.before.digest, length: 2 }, after: { digest: input.after.digest, length: 2 },
    changes: [{ fromA: 1, toA: 2, fromB: 1, toB: 2 }] }
  assert.equal(validDiff(unicode, caps.diffAlgorithm, input, '😀', '😁'), false)
})

test('CodeMirror receives fresh Change instances, presentation never mutates cached DTOs, and precision ignores global crude state', () => {
  const computed = result()
  const saved = structuredClone(computed)
  const config = codeDiffConfig(computed)
  const first = config.override!('abc', 'axc'), second = config.override!('abc', 'axc')
  assert.notEqual(first[0], second[0])
  // Exercise CodeMirror's offset() calls and its presentation pass against the same cache entry repeatedly.
  for (let i = 0; i < 3; i++) {
    presentableDiff('abc', 'axc', config)
    assert.equal(Chunk.build(Text.of(['abc']), Text.of(['axc']), config).length, 1)
    assert.equal(buildUnifiedDiff('abc', 'axc', computed).changes.length, 1)
  }
  assert.deepEqual(computed, saved)
  diff('a'.repeat(2000), 'b'.repeat(2000), { scanLimit: 1 })
  assert.equal(buildUnifiedDiff('abc', 'axc', computed).precise, true)
  assert.equal(buildUnifiedDiff('abc', 'axc', { ...computed, precise: false }).precise, false)
})

test('layout projection excludes source, comments, language and unrelated sizes, preserving comparison union inputs', async () => {
  const nodes = sampleReview.nodes.slice(0, 1), edges = sampleReview.edges.slice(0, 0)
  const projected = layoutInput(nodes, edges, new Map([['unrelated', { width: 999, height: 999 }]]), { nodes, edges })
  const changed = nodes.map(node => ({ ...node, detail: 'new discussion detail', evidence: [] }))
  assert.deepEqual(layoutInput(changed, edges, new Map(), { nodes: changed, edges }), projected)
  assert.deepEqual(Object.keys(projected.nodes[0]), ['id', 'kind', 'position', 'title', 'summary'])
  assert.ok(!JSON.stringify(projected).includes('evidence'))
  assert.deepEqual(sourceReference({ ...reference, code: 'private saved source' }), reference)
  const sent: LayoutInput[] = []
  const client = createPrecomputeClient(async (url, options) => {
    if (String(url) === '/api/precompute') return response(caps)
    sent.push(JSON.parse(String(options?.body)))
    return response({ schemaVersion: 1, algorithm: caps.layoutAlgorithm, key: `layout-${sent.length}`, usesAuthoredPositions: false,
      nodes: { [nodes[0].id]: { position: { x: 0, y: 0 }, width: 248, height: 160, ports: [] } }, edges: {} })
  })
  assert.equal((await client.layout('saved', projected))?.key, 'layout-1')
  assert.equal((await client.layout('saved', projected))?.key, 'layout-1')
  assert.equal((await client.layout('saved', { ...projected, sizes: [{ id: nodes[0].id, width: 270, height: 190 }] }))?.key, 'layout-2')
  assert.deepEqual(sent[0].reference, projected.reference)
  assert.equal(sent.length, 2)
})
