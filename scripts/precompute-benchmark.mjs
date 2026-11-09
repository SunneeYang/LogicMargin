import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binary = resolve(process.env.LOGIC_MARGIN_GO_BINARY ?? join(root, 'artifacts/go', `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin'))
const hash = value => createHash('sha256').update(value).digest('hex')
const cacheStatuses = new Set(['miss', 'memory', 'disk', 'shared'])
const reference = ({ path, symbol, startLine, endLine, digest }) => ({ path, symbol, startLine, endLine, digest })

function validateDiff(value, before, after) {
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.coordinate, 'utf16')
  assert.match(value.key, /^[a-f0-9]{64}$/)
  assert.equal(typeof value.precise, 'boolean')
  assert.deepEqual(value.before, { digest: hash(before), length: before.length })
  assert.deepEqual(value.after, { digest: hash(after), length: after.length })
  const boundary = (text, at) => at === 0 || at === text.length ||
    !(/[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]))
  let a = 0, b = 0
  for (const { fromA, toA, fromB, toB } of value.changes) {
    assert.ok([fromA, toA, fromB, toB].every(Number.isSafeInteger))
    assert.ok(a <= fromA && fromA <= toA && toA <= before.length)
    assert.ok(b <= fromB && fromB <= toB && toB <= after.length)
    assert.ok(boundary(before, fromA) && boundary(before, toA) && boundary(after, fromB) && boundary(after, toB))
    assert.equal(before.slice(a, fromA), after.slice(b, fromB))
    a = toA; b = toB
  }
  assert.equal(before.slice(a), after.slice(b))
}

function validateLayout(value, input) {
  assert.equal(value.schemaVersion, 1)
  assert.match(value.key, /^[a-f0-9]{64}$/)
  assert.equal(typeof value.usesAuthoredPositions, 'boolean')
  assert.deepEqual(Object.keys(value.nodes).sort(), input.nodes.map(node => node.id).sort())
  assert.deepEqual(Object.keys(value.edges).sort(), input.edges.map(edge => edge.id).sort())
  const point = point => assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  for (const node of Object.values(value.nodes)) {
    point(node.position)
    assert.ok(Number.isFinite(node.width) && node.width > 0 && Number.isFinite(node.height) && node.height > 0)
    assert.ok(Array.isArray(node.ports))
  }
  for (const { id, source, target } of input.edges) {
    const edge = value.edges[id]
    assert.ok(edge.points.length >= 2)
    edge.points.forEach(point); point(edge.label)
    assert.ok(value.nodes[source].ports.some(port => port.type === 'source' && port.id === edge.sourceHandle))
    assert.ok(value.nodes[target].ports.some(port => port.type === 'target' && port.id === edge.targetHandle))
  }
}

function selfTest() {
  const before = 'a😀\nb', after = 'a😁\nb'
  const value = { schemaVersion: 1, coordinate: 'utf16', key: 'a'.repeat(64), precise: true,
    before: { digest: hash(before), length: before.length }, after: { digest: hash(after), length: after.length },
    changes: [{ fromA: 1, toA: 3, fromB: 1, toB: 3 }] }
  validateDiff(value, before, after)
  assert.throws(() => validateDiff({ ...value, changes: [{ fromA: 2, toA: 3, fromB: 2, toB: 3 }] }, before, after))
  assert.throws(() => validateDiff({ ...value, changes: [] }, before, after))
  const input = { nodes: [{ id: 'a' }], edges: [] }
  const layout = { schemaVersion: 1, key: 'b'.repeat(64), usesAuthoredPositions: false,
    nodes: { a: { position: { x: 1, y: 2 }, width: 280, height: 160, ports: [] } }, edges: {} }
  validateLayout(layout, input)
  assert.throws(() => validateLayout({ ...layout, nodes: {} }, input))
  assert.throws(() => validateLayout({ ...layout, nodes: { a: { ...layout.nodes.a, position: { x: NaN, y: 0 } } } }, input))
  console.log('precompute benchmark self-check passed')
}

const args = process.argv.slice(2)
if (args[0] === '--self-test' && args.length === 1) selfTest()
else if (args[0] === '--help' && args.length === 1) {
  console.log('Usage: node scripts/precompute-benchmark.mjs OUTPUT.json\n' +
    'Uses LOGIC_MARGIN_GO_BINARY or artifacts/go/<platform>-<arch>/logic-margin; never builds.\n' +
    'Run through agent-tmp-run. Uses only private temporary sessions and a loopback port.\n' +
    'Three fixed input sizes, one miss + ten memory hits + one restart/disk hit per operation.\n' +
    'HTTP wall time includes response body consumption, excludes JSON encoding/decoding. Go CPU is not measured.\n' +
    'Use --self-test to check measurement assertions without a Go program.')
} else if (args.length !== 1 || args[0].startsWith('--')) {
  console.error('Usage: node scripts/precompute-benchmark.mjs OUTPUT.json | --self-test | --help')
  process.exitCode = 2
} else {
  await main(resolve(args[0]))
}

async function main(output) {
  const report = {
    capturedAt: new Date().toISOString(), status: 'running',
    machine: { cpu: cpus()[0]?.model, logicalCPUs: cpus().length, os: platform(), release: release(), arch: process.arch, driverNode: process.version },
    binary: { path: binary },
    scope: {
      httpWallMs: 'Sequential loopback fetch through complete identity-encoded response body; excludes request JSON encoding and response JSON parsing. Includes source resolution, cache IO, scheduling, compute and HTTP serialization.',
      first: 'First POST to a fresh private derived cache, asserted miss. Sessions are seeded before server launch using the existing SessionStore; no HTTP session GET/create triggers prewarming before first measurements.',
      memory: 'Ten sequential repeats, each asserted memory; no OS cache flush or statistical speedup claim.',
      disk: 'First repeat after one program restart, asserted disk; filesystem caches are not flushed.',
      goCpuMs: null,
      cpuReason: 'No per-request Go CPU instrumentation is exposed. Driver CPU and HTTP wall time are not substitutes for service CPU; neither is reported as Go CPU.',
      runtimeIsolation: 'Go is launched by absolute path with PATH set to an empty private directory; Node is used only by this development driver and fixture seeding.',
      excluded: ['browser/rendering', 'peak RSS', 'CPU utilization', 'other platforms', 'cold filesystem', 'multiuser load', 'production data'],
    },
    cases: [],
  }
  let temp, active
  const controller = new AbortController()
  const abort = () => { controller.abort(new Error('Benchmark interrupted')); active?.child.kill('SIGTERM') }
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  const within = async (promise, ms, label) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) }
    finally { clearTimeout(timer) }
  }
  async function stop() {
    if (!active) return
    const server = active
    if (server.child.exitCode === null && server.child.signalCode === null) {
      if (server.url) await fetch(`${server.url}/api/shutdown`, { method: 'POST',
        headers: { 'x-logic-margin-token': server.token }, signal: AbortSignal.timeout(2000) }).catch(() => {})
      try { await within(server.exited, 5000, 'graceful shutdown timeout') }
      catch {
        server.child.kill('SIGTERM')
        try { await within(server.exited, 2000, 'termination timeout') }
        catch { server.child.kill('SIGKILL'); await server.exited }
      }
    } else await server.exited
    server.lines.close(); active = undefined
  }
  async function start(data) {
    controller.signal.throwIfAborted()
    const home = join(temp, 'home'), token = randomUUID()
    const child = spawn(binary, ['_serve', '--home', home, '--data-dir', data, '--host', '127.0.0.1', '--port', '0',
      '--instance-id', 'precompute-benchmark', '--shutdown-token', token], {
      cwd: temp, env: { ...process.env, PATH: join(temp, 'no-js-runtimes'), LOGIC_MARGIN_HOME: home, LOGIC_MARGIN_DATA_DIR: data },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    const lines = createInterface({ input: child.stdout })
    active = { child, exited, lines, token }
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      lines.once('line', line => { try { resolve(JSON.parse(line).url) } catch (error) { reject(error) } })
      exited.then(() => reject(new Error(stderr || 'Go program exited before readiness')))
    })
    const base = await within(ready, 15000, 'Go startup timeout')
    assert.equal(new URL(base).hostname, '127.0.0.1')
    active.url = base
    return base
  }
  async function json(base, path, body, measured = false) {
    controller.signal.throwIfAborted()
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const started = performance.now()
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'accept-encoding': 'identity', ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }) },
      body: encoded, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
    const bytes = Buffer.from(await response.arrayBuffer()), httpWallMs = performance.now() - started
    assert.equal(response.status, 200, `${path}: ${bytes.toString('utf8').slice(0, 500)}${response.status === 404 && path.includes('precompute') ? '; rebuild the current Go program if its precompute API is missing' : ''}`)
    const cache = response.headers.get('x-logic-margin-cache')
    if (measured) assert.ok(cacheStatuses.has(cache), `Missing/invalid X-Logic-Margin-Cache: ${cache}`)
    return { value: JSON.parse(bytes.toString('utf8')), timing: { httpWallMs, cache, requestBytes: encoded ? Buffer.byteLength(encoded) : 0, responseBytes: bytes.length } }
  }
  try {
    await access(binary)
    report.binary.sha256 = hash(await readFile(binary))
    temp = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-precompute-bench-'))
    await mkdir(join(temp, 'no-js-runtimes'))
    const data = join(temp, 'sessions')
    const { SessionStore } = await import('../server/session-store.ts')
    const { contextReview } = await import('../tests/fixtures/context-review.ts')
    const store = new SessionStore(data)
    const fixtures = []
    for (const sample of [{ name: 'short', lines: 194, nodes: 12 }, { name: 'long', lines: 1998, nodes: 48 }, { name: 'wide', lines: 1998, nodes: 96 }]) {
      const review = contextReview(sample.lines)
      review.id = `backend-benchmark-${sample.name}`
      review.baseline.id = review.id
      if (sample.name === 'wide') for (const document of [review.baseline, review]) {
        const evidence = document.nodes[0].evidence[0]
        evidence.code = evidence.code.split('\n').map(line => `${line} // 你好😀 fixed padding`).join('\n')
        evidence.digest = hash(evidence.code)
        const files = [{ path: evidence.path, sha256: hash(`${'// preceding context\n'.repeat(100)}${evidence.code}`) }]
        document.snapshot = { ...document.snapshot, files, fingerprint: hash(JSON.stringify(files)) }
      }
      const original = review.nodes[0]
      review.nodes = Array.from({ length: sample.nodes }, (_, index) => ({ ...structuredClone(original), id: `node-${index}`,
        title: `${sample.name} · 步骤 ${index}`, summary: '固定布局输入；不包含批注或证据源码。', position: { x: 0, y: index * 180 },
        evidence: index ? [] : original.evidence }))
      review.edges = review.nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, sceneId: original.sceneId,
        source: review.nodes[index].id, target: node.id, label: index % 4 ? '继续' : '条件通过', detail: 'synthetic fixture' }))
      const state = await store.create(review)
      // All source material below is from this saved session; never resolve its paths in the checkout.
      const before = state.review.baseline.nodes[0].evidence[0], after = state.review.nodes[0].evidence[0]
      const diff = { beforeSnapshot: { kind: 'baseline' }, afterSnapshot: { kind: 'round', round: 1 }, before: reference(before), after: reference(after) }
      const layout = { nodes: state.review.nodes.map(({ id, kind, position, title, summary }) => ({ id, kind, position, title, summary })),
        edges: state.review.edges.map(({ id, source, target, label }) => ({ id, source, target, label })),
        sizes: state.review.nodes.map(({ id }) => ({ id, width: 280, height: 160 })) }
      fixtures.push({ state, diff, layout, before, after })
      report.cases.push({ name: sample.name, session: state.id,
        input: { before: { utf16Units: before.code.length, utf8Bytes: Buffer.byteLength(before.code), sha256: before.digest },
          after: { utf16Units: after.code.length, utf8Bytes: Buffer.byteLength(after.code), sha256: after.digest },
          lines: sample.lines, nodes: layout.nodes.length, edges: layout.edges.length, layoutJSONBytes: Buffer.byteLength(JSON.stringify(layout)),
          savedSessionSHA256: hash(await readFile(join(data, `${state.id}.json`))), savedSourceFiles: { before: state.review.baseline.snapshot.files, after: state.review.snapshot.files } } })
    }
    let base = await start(data)
    report.capabilities = (await json(base, '/api/precompute')).value
    assert.equal(report.capabilities.schemaVersion, 1)
    assert.equal(report.capabilities.coordinate, 'utf16')
    report.version = (await json(base, '/api/health')).value.version
    for (const [index, fixture] of fixtures.entries()) {
      const entry = report.cases[index], path = `/api/review-sessions/${fixture.state.id}`
      for (const kind of ['diff', 'layout']) {
        const first = await json(base, `${path}/precompute/${kind}`, fixture[kind], true)
        assert.equal(first.timing.cache, 'miss', 'First computation was prewarmed; do not label it cold')
        if (kind === 'diff') validateDiff(first.value, fixture.before.code, fixture.after.code)
        else validateLayout(first.value, fixture.layout)
        entry[kind] = { key: first.value.key, algorithm: first.value.algorithm, ...(kind === 'diff' ? { precise: first.value.precise, changes: first.value.changes.length } : {}),
          first: first.timing, memory: [] }
        for (let n = 0; n < 10; n++) {
          const cached = await json(base, `${path}/precompute/${kind}`, fixture[kind], true)
          assert.equal(cached.timing.cache, 'memory')
          assert.deepEqual(cached.value, first.value)
          entry[kind].memory.push(cached.timing)
        }
      }
    }
    // Restart only once for all disk-cache measurements; do not rebuild between cases.
    await stop(); base = await start(data)
    for (const [index, fixture] of fixtures.entries()) {
      const entry = report.cases[index], path = `/api/review-sessions/${fixture.state.id}`
      for (const kind of ['diff', 'layout']) {
        const disk = await json(base, `${path}/precompute/${kind}`, fixture[kind], true)
        assert.equal(disk.timing.cache, 'disk')
        assert.equal(disk.value.key, entry[kind].key)
        entry[kind].disk = disk.timing
      }
      const comment = { id: `bench-${index}`, targets: [{ kind: 'node', id: fixture.state.review.nodes[0].id }], revision: fixture.state.review.revision,
        body: '只有批注变化，源码和几何不变。', status: 'open', createdAt: '2026-11-09T00:00:00.000Z' }
      const mutation = async mutations => (await json(base, `${path}/mutations`, { round: 1, revision: fixture.state.review.revision,
        fingerprint: fixture.state.review.snapshot.fingerprint, mutations })).value
      await mutation([{ kind: 'add-comment', comment }])
      await mutation([{ kind: 'add-reply', commentId: comment.id, reply: { id: `reply-${index}`, author: 'reviewer', body: '补充验收意见。',
        revision: fixture.state.review.revision, createdAt: '2026-11-09T00:00:01.000Z' } }])
      entry.afterAnnotation = {}
      for (const kind of ['diff', 'layout']) {
        const unchanged = await json(base, `${path}/precompute/${kind}`, fixture[kind], true)
        assert.equal(unchanged.value.key, entry[kind].key, `${kind} key changed after annotation-only mutations`)
        entry.afterAnnotation[kind] = { key: unchanged.value.key, ...unchanged.timing }
      }
      const resized = structuredClone(fixture.layout)
      resized.sizes[0].width += 41
      const changed = await json(base, `${path}/precompute/layout`, resized, true)
      validateLayout(changed.value, resized)
      assert.notEqual(changed.value.key, entry.layout.key, 'Measured dimensions must change the layout key')
      entry.resizedLayout = { key: changed.value.key, ...changed.timing }
      const repeated = await json(base, `${path}/precompute/layout`, resized, true)
      assert.equal(repeated.value.key, changed.value.key)
      assert.equal(repeated.timing.cache, 'memory')
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = error.stack ?? String(error)
    console.error(error.message)
    process.exitCode = 1
  } finally {
    try { await stop() } catch (error) {
      report.status = 'failed'; report.cleanupError = error.stack ?? String(error); process.exitCode = 1
    }
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
    if (temp) await rm(temp, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(output)
  }
}
