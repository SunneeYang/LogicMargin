import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createPrecomputeClient } from './precompute.ts'
import type { ComputedDiff, DiffInput } from './precompute.ts'
import { moveEvidence, unifiedStructureRanges, validStructure } from './structural-code-diff.ts'
import type { StructureResult } from './structural-code-diff.ts'
import { buildUnifiedDiff } from './unified-code-diff.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const before = 'func Move😀() { return "旧" }\nfunc Stay() {}'
const after = 'func Stay() {}\nfunc Move😀() { return "新" }'
const reference = { path: 'saved.go', symbol: 'saved', startLine: 21, endLine: 22, digest: sha(before) }
const input: DiffInput = { beforeSnapshot: { kind: 'baseline' }, afterSnapshot: { kind: 'round', round: 2 },
  before: reference, after: { ...reference, digest: sha(after) } }
const caps = { schemaVersion: 1, coordinate: 'utf16', diffAlgorithm: 'diff-v1', layoutAlgorithm: 'layout-v1', structureAlgorithm: 'structure-v1' }
function comparison(a: string, b: string): ComputedDiff {
  return { schemaVersion: 1, algorithm: caps.diffAlgorithm, key: `diff-${sha(a + b)}`, coordinate: 'utf16', language: 'go', precise: true,
    before: { digest: sha(a), length: a.length }, after: { digest: sha(b), length: b.length },
    changes: a === b ? [] : [{ fromA: 0, toA: a.length, fromB: 0, toB: b.length }] }
}
function structure(): StructureResult {
  const scope = { id: 'move-1', kind: 'function', name: 'Move😀', before: { from: 0, to: before.indexOf('\n') }, after: { from: after.indexOf('\n') + 1, to: after.length } }
  return { schemaVersion: 1, algorithm: caps.structureAlgorithm, key: 'structure-key', coordinate: 'utf16', language: 'go',
    before: { digest: sha(before), length: before.length }, after: { digest: sha(after), length: after.length },
    mode: 'structural', formattingOnly: false, highlights: { before: [{ from: before.indexOf('旧'), to: before.indexOf('旧') + 1 }],
      after: [{ from: after.indexOf('新'), to: after.indexOf('新') + 1 }] }, scopes: [scope],
    moves: [{ ...scope, modified: true, highlights: { before: [{ from: before.indexOf('旧'), to: before.indexOf('旧') + 1 }],
      after: [{ from: after.indexOf('新') - scope.after.from, to: after.indexOf('新') - scope.after.from + 1 }] },
      comparison: comparison(before.slice(scope.before.from, scope.before.to), after.slice(scope.after.from, scope.after.to)) }] }
}
const valid = (value: unknown, a = before, b = after) => validStructure(value, caps.structureAlgorithm, caps.diffAlgorithm, input, a, b)
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('structure validates source digests, UTF16 ranges, scope references and saved move comparisons', async () => {
  assert.equal(await valid(structure()), true)
  const mutations: ((value: any) => void)[] = [
    value => { value.before.digest = 'wrong' }, value => { value.before.length++ }, value => { value.algorithm = 'other' },
    value => { value.coordinate = 'utf8' }, value => { value.key = '' }, value => { value.highlights = null },
    value => { value.highlights.before = [{ from: -1, to: 2 }] }, value => { value.highlights.after = [{ from: 2, to: after.length + 1 }] },
    value => { const cut = before.indexOf('😀') + 1; value.highlights.before = [{ from: cut, to: cut + 1 }] },
    value => { value.scopes[0].after.to++ }, value => { value.moves[0].id = 'orphan' },
    value => { value.moves[0].before.to-- }, value => { value.moves[0].comparison.before.digest = 'wrong' },
    value => { value.moves[0].comparison.changes = [] }, value => { value.moves[0].highlights.after = [{ from: 0, to: 9999 }] },
    value => { value.scopes.push({ ...value.scopes[0], id: 'duplicate' }) },
    value => { value.moves.push(value.moves[0]) }, value => { value.formattingOnly = true },
  ]
  for (const mutate of mutations) { const value = structure(); mutate(value); assert.equal(await valid(value), false, String(mutate)) }
  assert.equal(await valid(structure(), before.replace('旧', '错')), false, 'same lengths and references cannot hide wrong source')
  const fallback = { ...structure(), mode: 'text', reason: 'syntax-boundary', formattingOnly: false, highlights: { before: [], after: [] }, scopes: [], moves: [] }
  assert.equal(await valid(fallback), true)
  assert.equal(await valid({ ...fallback, reason: 'unknown' }), false)
  assert.equal(await valid({ ...structure(), moves: null }), false)
})

test('structure transport uses only snapshot references, deduplicates, caches and cancels independently', async () => {
  const requests: { url: string; body: unknown }[] = []
  let finish!: (value: Response) => void
  const client = createPrecomputeClient(async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined })
    return String(url) === '/api/precompute' ? response(caps) : new Promise(resolve => { finish = resolve })
  })
  const controller = new AbortController()
  const a = client.structure('a/b', input, before, after, controller.signal), rejected = assert.rejects(a, { name: 'AbortError' })
  const b = client.structure('a/b', input, before, after)
  await tick(); controller.abort(); finish(response(structure())); await rejected
  assert.deepEqual(await b, structure())
  assert.deepEqual(await client.structure('a/b', input, before, after), structure())
  assert.equal(await client.structure('a/b', input, before.replace('旧', '错'), after), null)
  assert.deepEqual(requests, [{ url: '/api/precompute', body: undefined }, { url: '/api/review-sessions/a%2Fb/precompute/structure', body: input }])
})

test('background structure gets a longer request deadline while capability checks stay short', async t => {
  const deadlines: number[] = []
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms)
    return new AbortController().signal
  })
  const client = createPrecomputeClient(async url => response(String(url) === '/api/precompute' ? caps : structure()))
  assert.deepEqual(await client.structure('saved', input, before, after), structure())
  assert.deepEqual(deadlines, [2000, 20_000])
})

test('optional capabilities, old endpoints, invalid data and timeouts preserve text fallback', async t => {
  for (const capabilities of [null, { ...caps, structureAlgorithm: undefined }, { ...caps, structureAlgorithm: null }]) {
    let posts = 0
    const client = createPrecomputeClient(async url => { if (String(url) === '/api/precompute') return response(capabilities); posts++; return response(structure()) })
    assert.equal(await client.structure(undefined, input, before, after), null)
    assert.equal(await client.structure('saved', input, before, after), null); assert.equal(posts, 0)
  }
  for (const data of [null, { ...structure(), key: '' }, { ...structure(), before: { digest: 'bad', length: before.length } }]) {
    const client = createPrecomputeClient(async url => response(String(url) === '/api/precompute' ? caps : data))
    assert.equal(await client.structure('saved', input, before, after), null)
  }
  const old = createPrecomputeClient(async url => String(url) === '/api/precompute' ? response(caps) : new Response('', { status: 404 }))
  assert.equal(await old.structure('saved', input, before, after), null)
  const timeout = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal)
  const client = createPrecomputeClient(async (url, options) => String(url) === '/api/precompute' ? response(caps)
    : new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))))
  const pending = client.structure('saved', input, before, after)
  await tick(); timeout.abort(new DOMException('Timed out', 'TimeoutError')); assert.equal(await pending, null)
})

test('unified structure mapping preserves original text alignment, source offsets and moved slice line numbers', () => {
  const raw = comparison(before, after), saved = structuredClone(raw)
  const unified = buildUnifiedDiff(before, after, raw)
  const ranges = unifiedStructureRanges(unified, structure().highlights, before, after)
  assert.deepEqual(ranges.map(range => [range.kind, unified.doc.sliceString(range.from, range.to)]), [['removed', '旧'], ['added', '新']])
  assert.deepEqual(raw, saved)
  const move = structure().moves[0]
  assert.deepEqual(moveEvidence({ ...reference, code: before }, move.before, move.comparison.before.digest),
    { ...reference, code: before.split('\n')[0], digest: move.comparison.before.digest, startLine: 21, endLine: 21 })
  assert.equal(moveEvidence({ ...input.after, code: after }, move.after, move.comparison.after.digest).startLine, 22)
})

test('unmodified moves retain whitespace text comparisons while duplicate or cut-scope references fail closed', async () => {
  const value = structure(), move = value.moves[0]
  move.modified = false; move.highlights = { before: [], after: [] }
  // The frontend preserves the engine's classification and every raw text change.
  assert.equal(await valid(value), true)
  const duplicate = structure()
  duplicate.scopes.push({ id: 'same-name', kind: 'function', name: 'Move😀', before: { from: before.indexOf('\n') + 1, to: before.length }, after: { from: 0, to: after.indexOf('\n') } })
  assert.equal(await valid(duplicate), false)
  const cut = structure()
  cut.scopes[0].before.from = before.indexOf('😀') + 1
  assert.equal(await valid(cut), false)
})

test('the last structure cancellation aborts transport and rejects late cache insertion', async () => {
  let finish!: (value: Response) => void, signal: AbortSignal | undefined, posts = 0
  const client = createPrecomputeClient(async (url, options) => {
    if (String(url) === '/api/precompute') return response(caps)
    posts++; signal = options?.signal ?? undefined
    return new Promise(resolve => { finish = resolve })
  })
  const controller = new AbortController()
  const pending = client.structure('saved', input, before, after, controller.signal), rejected = assert.rejects(pending, { name: 'AbortError' })
  await tick(); controller.abort(); await rejected; assert.equal(signal?.aborted, true)
  finish(response(structure())); await tick()
  const next = client.structure('saved', input, before, after)
  await tick(); finish(response({ ...structure(), key: 'fresh' }))
  assert.equal((await next)?.key, 'fresh'); assert.equal(posts, 2)
})

test('HTTP without crypto.subtle still validates top-level and nested source digests', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    for (const crypto of [{}, undefined]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto })
      assert.equal(await valid(structure()), true)
      assert.equal(await valid(structure(), before.replace('旧', '错')), false)
      const wrong = structure(); wrong.moves[0].comparison.after.digest = '0'.repeat(64)
      assert.equal(await valid(wrong), false)
      const client = createPrecomputeClient(async url => response(String(url) === '/api/precompute' ? caps : structure()))
      assert.deepEqual(await client.structure('http-saved', input, before, after), structure())
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
})
