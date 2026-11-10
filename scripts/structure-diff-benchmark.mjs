import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, loadavg, platform, release, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { startGo, seedGoSessions } from './go-process.mjs'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = value => createHash('sha256').update(value).digest('hex')
const cacheStatuses = new Set(['miss', 'memory', 'disk', 'shared'])
const fallbackReasons = new Set(['unsupported-language', 'invalid-syntax', 'budget', 'syntax-boundary'])
const boundary = (text, at) => at === 0 || at === text.length ||
  !(/[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]))

function ranges(items, text) {
  assert.ok(Array.isArray(items))
  let end = 0
  for (const { from, to } of items) {
    assert.ok(Number.isSafeInteger(from) && Number.isSafeInteger(to))
    assert.ok(end <= from && from <= to && to <= text.length)
    assert.ok(boundary(text, from) && boundary(text, to), 'Range splits a UTF-16 surrogate pair')
    end = to
  }
}

function metadata(value, before, after) {
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.coordinate, 'utf16')
  assert.match(value.key, /^[a-f0-9]{64}$/)
  assert.ok(typeof value.algorithm === 'string' && value.algorithm.length)
  assert.deepEqual(value.before, { digest: hash(before), length: before.length })
  assert.deepEqual(value.after, { digest: hash(after), length: after.length })
}

function validateDiff(value, before, after) {
  metadata(value, before, after)
  assert.equal(typeof value.precise, 'boolean')
  let a = 0, b = 0
  for (const { fromA, toA, fromB, toB } of value.changes) {
    ranges([{ from: fromA, to: toA }], before); ranges([{ from: fromB, to: toB }], after)
    assert.ok(a <= fromA && b <= fromB)
    assert.equal(before.slice(a, fromA), after.slice(b, fromB), 'Raw diff omitted changed text')
    a = toA; b = toB
  }
  assert.equal(before.slice(a), after.slice(b))
}

function validateStructure(value, before, after, movedName) {
  metadata(value, before, after)
  assert.ok(['structural', 'text'].includes(value.mode))
  assert.equal(typeof value.formattingOnly, 'boolean')
  ranges(value.highlights.before, before); ranges(value.highlights.after, after)
  assert.ok(Array.isArray(value.scopes) && Array.isArray(value.moves))
  assert.equal(new Set(value.scopes.map(scope => scope.id)).size, value.scopes.length)
  assert.equal(new Set(value.scopes.map(scope => `${scope.kind}:${scope.name}`)).size, value.scopes.length)
  for (const scope of value.scopes) {
    assert.ok(scope.id && scope.kind && scope.name)
    ranges([scope.before], before); ranges([scope.after], after)
  }
  for (const move of value.moves) {
    assert.ok(value.scopes.some(scope => scope.id === move.id && scope.name === move.name && scope.kind === move.kind &&
      scope.before.from === move.before.from && scope.before.to === move.before.to && scope.after.from === move.after.from && scope.after.to === move.after.to))
    const a = before.slice(move.before.from, move.before.to), b = after.slice(move.after.from, move.after.to)
    ranges(move.highlights.before, a); ranges(move.highlights.after, b)
    validateDiff(move.comparison, a, b)
    assert.equal(typeof move.modified, 'boolean')
  }
  if (value.mode === 'text') {
    assert.ok(fallbackReasons.has(value.reason), 'Text fallback must explain why parsing did not produce structural results')
    assert.equal(value.formattingOnly, false)
    assert.deepEqual(value.moves, [])
    return { parsedSuccessfully: false, fallbackReason: value.reason, rangesAndMovesValidated: true }
  }
  assert.equal(value.reason, undefined)
  assert.equal(value.formattingOnly, false)
  assert.deepEqual(value.moves.map(move => ({ name: move.name, modified: move.modified })), [{ name: movedName, modified: true }])
  assert.ok(value.moves[0].comparison.changes.length > 0)
  return { parsedSuccessfully: true, fallbackReason: null, rangesAndMovesValidated: true }
}

function fixture(name, language, target) {
  const header = language === 'go' ? 'package synthetic\n// 中文😀：固定合成多函数输入\n\n' : '// 中文😀：固定合成多函数输入\n\n'
  const fn = (index, changed = false) => {
    const name = `Scope${String(index).padStart(4, '0')}`, seed = index * 137 + 17
    const body = Array.from({ length: 12 }, (_, line) => `  total += ${seed + line + (changed && line === 5 ? 1 : 0)}${language === 'go' ? '' : ';'}${target >= 95000
      ? ` // ${name} step ${line}: 中文😀 fixed reproducible synthetic accumulator context` : ''}`)
    return [language === 'go' ? `func ${name}(value int) int {` : `export function ${name}(value: number): number {`,
      `  // ${name} 中文😀`, language === 'go' ? `  total := value + ${seed}` : `  let total: number = value + ${seed};`,
      ...body, language === 'go' ? '  return total' : '  return total;', '}'].join('\n')
  }
  const functions = [fn(0), fn(1), fn(2)]
  while ((header + functions.join('\n\n')).length < target) functions.push(fn(functions.length))
  const before = header + functions.join('\n\n'), after = header + [...functions.slice(1), fn(0, true)].join('\n\n')
  assert.ok(before.length < 100000 && after.length < 100000)
  assert.ok(before.split('\n').length <= 2000 && after.split('\n').length <= 2000)
  return { id: `${name}-${language}`, language, before, after, formattingOnly: false, moved: { name: 'Scope0000', modified: true } }
}

function distribution(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite))
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
  const middle = Math.floor(sorted.length / 2)
  return { samples: [...values], count: values.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: quantile(0.9), p95: quantile(0.95), max: sorted.at(-1) }
}

function summary(value) {
  return { key: value.key, algorithm: value.algorithm, ...(value.mode ? { mode: value.mode, reason: value.reason ?? null, language: value.language,
    parsedAs: value.parsedAs ?? null, formattingOnly: value.formattingOnly, highlights: value.highlights, scopes: value.scopes, moves: value.moves }
    : { precise: value.precise, changes: value.changes }) }
}

async function selfTest() {
  const { structuralCases, structuralReview, structuralReadingCase, validateStructuralFixture } = await import('../tests/fixtures/structural-review.ts')
  for (const sample of [...structuralCases, structuralReadingCase(194), structuralReadingCase(1998)]) validateStructuralFixture(structuralReview(sample))
  const before = 'a😀\nb', after = 'a😁\nb'
  const diff = { schemaVersion: 1, coordinate: 'utf16', key: 'a'.repeat(64), algorithm: 'self-test', precise: true,
    before: { digest: hash(before), length: before.length }, after: { digest: hash(after), length: after.length },
    changes: [{ fromA: 1, toA: 3, fromB: 1, toB: 3 }] }
  validateDiff(diff, before, after)
  assert.throws(() => validateDiff({ ...diff, changes: [] }, before, after))
  assert.throws(() => validateDiff({ ...diff, changes: [{ fromA: 2, toA: 3, fromB: 2, toB: 3 }] }, before, after))
  const structural = { ...diff, language: 'ts', mode: 'text', reason: 'budget', formattingOnly: false,
    highlights: { before: [], after: [] }, scopes: [], moves: [] }
  assert.equal(validateStructure(structural, before, after, 'unused').parsedSuccessfully, false)
  assert.throws(() => validateStructure({ ...structural, reason: undefined }, before, after, 'unused'))
  assert.throws(() => validateStructure({ ...structural, highlights: { before: [{ from: 2, to: 3 }], after: [] } }, before, after, 'unused'))
  const moved = { id: 'scope', kind: 'function', name: 'Example', before: { from: 0, to: before.length }, after: { from: 0, to: after.length } }
  const success = { ...structural, mode: 'structural', reason: undefined, scopes: [moved],
    moves: [{ ...moved, modified: true, highlights: { before: [{ from: 1, to: 3 }], after: [{ from: 1, to: 3 }] }, comparison: diff }] }
  assert.equal(validateStructure(success, before, after, 'Example').parsedSuccessfully, true)
  assert.throws(() => validateStructure({ ...success, moves: [{ ...success.moves[0], name: 'Wrong' }] }, before, after, 'Example'))
  assert.deepEqual(distribution([4, 1, 3, 2]), { samples: [4, 1, 3, 2], count: 4, min: 1, median: 2.5, p90: 4, p95: 4, max: 4 })
  for (const language of ['go', 'ts']) for (const [name, target] of [['short', 0], ['multi-function', 12000], ['near-100k', 95000]]) {
    const item = fixture(name, language, target)
    validateStructuralFixture(structuralReview(item))
    assert.ok(item.before !== item.after && item.before.includes('😀'))
    if (name === 'near-100k') assert.ok(item.before.length >= 95000)
  }
  console.log('structure diff benchmark self-check passed (validators, UTF-16, fallback accounting, distributions, fixed input sizes)')
}

async function main(output) {
  const binary = process.env.LOGIC_MARGIN_GO_BINARY ?? join(root, 'artifacts/go', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin')
  const variants = [...(process.env.LOGIC_MARGIN_GO_BASELINE_BINARY ? [{ name: 'text-baseline', path: process.env.LOGIC_MARGIN_GO_BASELINE_BINARY }] : []),
    { name: 'structure-candidate', path: binary }]
  const report = { schemaVersion: 1, status: 'running', capturedAt: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model, logicalCPUs: cpus().length, os: platform(), release: release(), arch: process.arch, driverNode: process.version, loadavg: loadavg() },
    harness: { scriptSHA256: hash(await readFile(fileURLToPath(import.meta.url))), fixtureSourceSHA256: hash(await readFile(join(root, 'tests/fixtures/structural-review.ts'))) },
    scope: { httpWallMs: 'Sequential localhost HTTP through the complete identity-encoded body, excluding request JSON encoding and response JSON parsing; includes saved-source resolution, cache IO, scheduling, parser/compute and serialization.',
      cold: 'Fresh process/private data+derived cache per binary; authoritative JSON copied from a separate stopped Go seeder, without measured HTTP create/get/prewarm. First POST for each operation must be miss. OS filesystem caches are not flushed.',
      memory: 'Ten sequential hits, each asserted memory, raw samples retained; nearest-rank p90/p95 with n=10 are descriptive, not confidence bounds. Cold, memory and disk samples are never pooled.',
      disk: 'First POST after one restart per binary, each asserted disk; OS caches remain warm.',
      runtimeIsolation: 'Absolute Go executable with PATH pointing at an empty private directory; only the development driver/seeder uses Node. No build is performed.',
      parserAttribution: { go: 'Go standard scanner/parser by implementation contract', ts: 'Lezer grammar in Goja by implementation contract' },
      fallback: 'mode:text is a validated fallback, never counted as successful semantic parsing; mode/reason and parsedAs are retained.',
      goCpuMs: null, cpuReason: 'No per-request Go CPU instrumentation is exposed. HTTP wall and Node driver CPU do not measure Go CPU.',
      excluded: ['browser/rendering', 'real private source', 'RSS', 'CPU profiles', 'cold filesystem', 'parallel load', 'absolute CI timing thresholds'] },
    baseline: { configured: Boolean(process.env.LOGIC_MARGIN_GO_BASELINE_BINARY), note: process.env.LOGIC_MARGIN_GO_BASELINE_BINARY
      ? 'Frozen pre-structure text program; its missing structure capability is retained as unsupported, not a failed parse.'
      : 'Set LOGIC_MARGIN_GO_BASELINE_BINARY to retain the pre-structure text baseline; no before/after cost claim is possible without it.' }, variants: [] }
  let temporary, active
  const controller = new AbortController()
  const abort = () => { controller.abort(new Error('Benchmark interrupted')); active?.child.kill('SIGTERM') }
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  async function stop() { await active?.stop(); active = undefined }
  async function start(variant, directory, data) {
    controller.signal.throwIfAborted()
    active = await startGo({ binary: variant.path, dataDir: data, cwd: directory, env: { ...process.env, PATH: join(temporary, 'no-js-runtimes') } })
    return active.url
  }
  async function json(base, path, body, measured = false) {
    controller.signal.throwIfAborted()
    const encoded = body === undefined ? undefined : JSON.stringify(body), started = performance.now()
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'accept-encoding': 'identity', ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }) }, body: encoded,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
    const bytes = Buffer.from(await response.arrayBuffer()), httpWallMs = performance.now() - started
    assert.equal(response.status, 200, `${path}: HTTP ${response.status} ${bytes.toString('utf8').slice(0, 400)}`)
    const cache = response.headers.get('x-logic-margin-cache')
    if (measured) assert.ok(cacheStatuses.has(cache), `Missing/invalid cache status: ${cache}`)
    return { value: JSON.parse(bytes.toString('utf8')), timing: { httpWallMs, cache, requestBytes: encoded ? Buffer.byteLength(encoded) : 0, responseBytes: bytes.length } }
  }
  try {
    for (const variant of variants) { assert.ok(isAbsolute(variant.path), 'Go binary paths must be absolute'); await access(variant.path); variant.sha256 = hash(await readFile(variant.path)) }
    temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-structure-benchmark-'))
    await mkdir(join(temporary, 'no-js-runtimes'))
    const { structuralReview, structuralInput, validateStructuralFixture } = await import('../tests/fixtures/structural-review.ts')
    for (const variant of variants) {
      const directory = join(temporary, variant.name), data = join(directory, 'sessions')
      const entry = { name: variant.name, binary: variant, cases: [] }
      report.variants.push(entry)
      await mkdir(directory, { recursive: true })
      const fixtures = []
      for (const language of ['go', 'ts']) for (const [name, target] of [['short', 0], ['multi-function', 12000], ['near-100k', 95000]]) {
        const sample = fixture(name, language, target)
        const [state] = await seedGoSessions([validateStructuralFixture(structuralReview(sample))], data)
        const bytes = await readFile(join(data, `${state.id}.json`))
        fixtures.push({ state, input: structuralInput(state.review), sample, savedSHA256: hash(bytes) })
        entry.cases.push({ name, language, input: { before: { utf16: sample.before.length, utf8Bytes: Buffer.byteLength(sample.before), sha256: hash(sample.before) },
          after: { utf16: sample.after.length, utf8Bytes: Buffer.byteLength(sample.after), sha256: hash(sample.after) }, functionCount: (sample.before.match(/(?:func |export function )Scope/g) ?? []).length,
          savedSessionSHA256: hash(bytes), files: { before: state.review.baseline.snapshot.files, after: state.review.snapshot.files } } })
      }
      let base = await start(variant, directory, data)
      entry.capabilities = (await json(base, '/api/precompute')).value
      assert.equal(entry.capabilities.schemaVersion, 1); assert.equal(entry.capabilities.coordinate, 'utf16')
      entry.version = (await json(base, '/api/health')).value.version
      const supportsStructure = typeof entry.capabilities.structureAlgorithm === 'string' && entry.capabilities.structureAlgorithm.length > 0
      if (variant.name === 'structure-candidate') assert.ok(supportsStructure, 'Candidate has no structure capability; do not use an old binary as semantic acceptance')
      const validate = (kind, value, sample) => kind === 'diff' ? (validateDiff(value, sample.before, sample.after), { rangesValidated: true })
        : validateStructure(value, sample.before, sample.after, sample.moved.name)
      for (const [index, { state, input, sample }] of fixtures.entries()) {
        const row = entry.cases[index], path = `/api/review-sessions/${state.id}/precompute`
        if (!supportsStructure) row.structure = { supported: false, reason: 'capability-absent', parsedSuccessfully: false }
        for (const kind of supportsStructure ? ['diff', 'structure'] : ['diff']) {
          const first = await json(base, `${path}/${kind}`, input, true)
          assert.equal(first.timing.cache, 'miss', `${variant.name} ${sample.id} ${kind} was prewarmed; cannot label cold`)
          const validation = validate(kind, first.value, sample)
          row[kind] = { supported: true, ...summary(first.value), validation, first: first.timing, memory: [] }
          for (let count = 0; count < 10; count++) {
            const hit = await json(base, `${path}/${kind}`, input, true)
            assert.equal(hit.timing.cache, 'memory'); assert.deepEqual(hit.value, first.value)
            row[kind].memory.push(hit.timing)
          }
          row[kind].memoryHTTPWallMs = distribution(row[kind].memory.map(item => item.httpWallMs))
        }
      }
      await stop(); base = await start(variant, directory, data)
      for (const [index, { state, input, sample, savedSHA256 }] of fixtures.entries()) {
        for (const kind of supportsStructure ? ['diff', 'structure'] : ['diff']) {
          const disk = await json(base, `/api/review-sessions/${state.id}/precompute/${kind}`, input, true)
          assert.equal(disk.timing.cache, 'disk')
          assert.deepEqual(summary(disk.value), summary(entry.cases[index][kind]))
          validate(kind, disk.value, sample)
          entry.cases[index][kind].disk = disk.timing
        }
        assert.equal(hash(await readFile(join(data, `${state.id}.json`))), savedSHA256, 'Read-only measurement mutated a saved source/session')
      }
      await stop()
      assert.equal(hash(await readFile(variant.path)), variant.sha256, 'Go executable changed during measurement')
      await writeFile(output, JSON.stringify(report, null, 2))
    }
    report.status = 'complete'
    report.semanticParsing = { success: report.variants.flatMap(item => item.cases).filter(row => row.structure.validation?.parsedSuccessfully).length,
      fallback: report.variants.flatMap(item => item.cases).filter(row => row.structure.supported && !row.structure.validation?.parsedSuccessfully).map(row => ({ name: row.name, language: row.language, reason: row.structure.reason })) }
    const baseline = report.variants.find(item => item.name === 'text-baseline'), candidate = report.variants.find(item => item.name === 'structure-candidate')
    const timings = operation => ({ coldHTTPWallMs: operation.first.httpWallMs, memoryMedianHTTPWallMs: operation.memoryHTTPWallMs.median, diskHTTPWallMs: operation.disk.httpWallMs })
    report.costs = { note: 'Independent sequential HTTP operation costs, not browser latency or Go CPU. Requests may run in parallel in the UI; do not sum these values as UI elapsed time.',
      cases: candidate.cases.map(row => { const old = baseline?.cases.find(item => item.name === row.name && item.language === row.language)
        return { name: row.name, language: row.language, textBaseline: old ? timings(old.diff) : null, candidateText: timings(row.diff),
          addedStructureRequest: { ...timings(row.structure), mode: row.structure.mode, reason: row.structure.reason, parsedSuccessfully: row.structure.validation.parsedSuccessfully } } }) }
  } catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1 }
  finally {
    try { await stop() } catch (error) { report.status = 'failed'; report.cleanupError = error.stack ?? String(error); process.exitCode = 1 }
    process.off('SIGINT', abort); process.off('SIGTERM', abort)
    if (temporary) await rm(temporary, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`${report.status}: ${output}`)
  }
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--self-test') await selfTest()
else if (args.length === 1 && args[0] === '--help') console.log('Usage: node scripts/structure-diff-benchmark.mjs OUTPUT.json\n' +
  'Run through agent-tmp-run; no build. LOGIC_MARGIN_GO_BINARY defaults to artifacts/go/<platform>-<arch>/logic-margin.\n' +
  'Optional LOGIC_MARGIN_GO_BASELINE_BINARY retains an older text-only baseline. Both paths must be absolute.\n' +
  'Go and TS at three fixed sizes: raw diff + structure cold miss / 10 memory / restart disk.\n' +
  'Records HTTP wall, raw samples, mode/reason, ranges/moves, hashes and bytes. Does not measure Go CPU or browser time.\n' +
  '--self-test checks validators and generated input sizes without launching any program.')
else if (args.length !== 1 || args[0].startsWith('--')) { console.error('Usage: node scripts/structure-diff-benchmark.mjs OUTPUT.json | --self-test | --help'); process.exitCode = 2 }
else { const output = resolve(args[0]); await mkdir(dirname(output), { recursive: true }); await access(output).then(() => { throw new Error('Refusing to overwrite an existing benchmark report') }, error => { if (error.code !== 'ENOENT') throw error }); await main(output) }
