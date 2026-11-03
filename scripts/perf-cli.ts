import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, arch, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runCli } from '../bin/logic-margin.ts'
import { verifyReviewSources } from '../bin/source-verification.ts'
import { parseReview } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import { createApprovalRecord } from '../src/workspace.ts'
import type { ReviewSession } from '../src/session-types.ts'

// Run through agent-tmp-run; all services and fixtures belong to this benchmark.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const round = (value: number) => Number(value.toFixed(3))
const sink = { out: (_value: string) => {}, err: (_value: string) => {} }
const measurements: Record<string, unknown> = {}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { min: round(sorted[0]), median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]), max: round(sorted.at(-1)!),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length) }
}

async function measure(name: string, operation: () => Promise<unknown> | unknown, options: { count?: number; warmups?: number; cpu?: boolean; afterEach?: () => Promise<void> } = {}) {
  const count = options.count ?? 12, warmups = options.warmups ?? 2
  const wall: number[] = [], cpu: number[] = []
  let firstObservedMs = 0
  for (let at = 0; at < count + warmups; at++) {
    const beforeCpu = process.cpuUsage(), start = performance.now()
    await operation()
    const elapsed = performance.now() - start, used = process.cpuUsage(beforeCpu)
    if (at === 0) firstObservedMs = elapsed
    if (at >= warmups) { wall.push(elapsed); cpu.push((used.user + used.system) / 1000) }
    await options.afterEach?.()
  }
  measurements[name] = { count, warmups, firstObservedMs: round(firstObservedMs), wallMs: distribution(wall),
    samplesMs: wall.map(round), ...(options.cpu ? { processCpuMs: distribution(cpu) } : {}) }
}

async function fixture(directory: string, name: string, totalBytes: number, fileCount: number, withEvidence = true) {
  const sourceRoot = join(directory, name)
  await mkdir(sourceRoot)
  const fileBytes = totalBytes / fileCount
  assert.ok(Number.isInteger(fileBytes) && fileBytes <= 10 * 1024 * 1024 && totalBytes <= 64 * 1024 * 1024)
  const bytes = Buffer.alloc(fileBytes)
  const line = `//${'x'.repeat(125)}\n`
  bytes.fill(line)
  const review = structuredClone(sampleReview)
  review.id = 'cli-performance-fixture'; review.comments = []
  review.nodes.forEach(node => { node.evidence = [] })
  const files = []
  for (let at = 0; at < fileCount; at++) {
    const path = `source-${String(at).padStart(4, '0')}.ts`
    await writeFile(join(sourceRoot, path), bytes)
    files.push({ path, sha256: sha256(bytes) })
    if (withEvidence) review.nodes[Math.floor(at / 20)].evidence.push({ path, symbol: 'synthetic fixture', startLine: 1, endLine: 1, digest: sha256(line.slice(0, -1)) })
  }
  review.snapshot = { ...review.snapshot, repository: 'synthetic performance fixture', commit: 'synthetic', dirty: true,
    files, fingerprint: sha256(JSON.stringify(files)) }
  const parsed = parseReview(review)
  const file = join(sourceRoot, 'review.json')
  await writeFile(file, JSON.stringify(parsed))
  return { name, sourceRoot, file, review: parsed, bytes, totalBytes, fileCount, evidenceCount: withEvidence ? fileCount : 0 }
}

async function main() {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const plugin = JSON.parse(await readFile(join(root, 'plugins/logic-margin/plugin.json'), 'utf8'))
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(plugin.version, version, 'runtime and plugin versions must match the package being measured')
  const archivePath = `artifacts/logic-margin-agent-${version}.zip`
  const archive = join(root, archivePath)
  const entry = `logic-margin-agent-${version}/plugins/logic-margin/skills/logic-margin/scripts/logic-margin.mjs`
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-perf-cli-'))
  const packaged = join(temporary, 'logic-margin.mjs')
  const daemonHome = join(temporary, 'managed-service')
  const env = { ...process.env, LOGIC_MARGIN_HOME: daemonHome, LOGIC_MARGIN_DATA_DIR: join(temporary, 'sessions') }
  delete env.LOGIC_MARGIN_URL; delete env.LOGIC_MARGIN_PUBLIC_URL
  const launch = (args: string[]) => execute(process.execPath, [packaged, ...args], { cwd: temporary, env, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
  let closeServer: (() => Promise<void>) | undefined
  try {
    const extracted = await execute('unzip', ['-p', archive, entry], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
    await writeFile(packaged, extracted.stdout)
    const cases = [
      await fixture(temporary, '1MiB-one-file-manifest', 1024 * 1024, 1, false),
      await fixture(temporary, '1MiB-one-file-evidence', 1024 * 1024, 1),
      await fixture(temporary, '16MiB-two-files-manifest', 16 * 1024 * 1024, 2, false),
      await fixture(temporary, '16MiB-two-files-evidence', 16 * 1024 * 1024, 2),
      await fixture(temporary, '1MiB-128-files-evidence', 1024 * 1024, 128),
    ]
    const review = cases[1].review
    const now = '2026-11-03T00:00:00Z'
    const session: ReviewSession = { schemaVersion: 1, id: 'perf-session', version: 1, round: 1, phase: 'awaiting-review',
      createdAt: now, updatedAt: now, review, history: [], snapshots: [{ round: 1, openedAt: now, review }] }
    const responseBody = JSON.stringify(session)
    const submittedBody = JSON.stringify({ ...session, version: 2, phase: 'approved', history: [createApprovalRecord(review)] })
    const eventDelivery: number[] = []
    let eventAvailableAt = 0
    const server = createServer((request, response) => {
      assert.equal(request.method, 'GET', 'benchmark stub must never accept writes')
      const query = new URL(request.url!, 'http://localhost').searchParams
      const send = (body: string) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body) }
      if (query.has('afterVersion')) setTimeout(() => { eventAvailableAt = performance.now(); send(submittedBody) }, 50)
      else send(responseBody)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    closeServer = async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`

    await measure('node_empty_process', () => execute(process.execPath, ['-e', ''], { cwd: temporary, env }))
    await measure('packaged_help_process', () => launch(['--help']))
    await measure('http_get_in_existing_process', async () => {
      const response = await fetch(`${url}/api/review-sessions/perf-session`)
      assert.equal(response.status, 200)
      assert.equal((await response.arrayBuffer()).byteLength, Buffer.byteLength(responseBody))
    }, { cpu: true })
    await measure('runCli_get_in_existing_process', () => runCli(['get', session.id, '--url', url], sink), { cpu: true })
    await measure('packaged_get_process_explicit_url', async () => { assert.equal(JSON.parse((await launch(['get', session.id, '--url', url])).stdout).id, session.id) })
    await measure('packaged_wait_event_delivery', async () => {
      const result = await launch(['wait', session.id, '--url', url, '--timeout', '5'])
      assert.equal(JSON.parse(result.stdout).approved, true)
      eventDelivery.push(performance.now() - eventAvailableAt)
    }, { count: 5, warmups: 1 })
    measurements.waitEventReadyToProcessExitMs = { injectedHoldMs: 50, count: eventDelivery.length - 1, wallMs: distribution(eventDelivery.slice(1)) }

    await measure('packaged_managed_service_cold_start', async () => { assert.equal(JSON.parse((await launch(['server', 'start'])).stdout).managed, true) },
      { count: 5, warmups: 0, afterEach: async () => { await launch(['server', 'stop']) } })
    await launch(['server', 'start'])
    await measure('packaged_managed_service_warm_reuse', () => launch(['server', 'start']))
    await launch(['server', 'stop'])

    for (const item of cases) {
      await measure(`sha256_in_memory_${item.name}`, () => { for (let at = 0; at < item.fileCount; at++) sha256(item.bytes) }, { cpu: true })
      await measure(`verifyReviewSources_${item.name}`, () => verifyReviewSources(item.review, item.sourceRoot), { cpu: true })
      if (item.evidenceCount) {
        await measure(`runCli_verify_${item.name}`, () => runCli(['verify', item.file, '--source-root', item.sourceRoot], sink), { cpu: true })
        await measure(`packaged_verify_process_${item.name}`, async () => {
          const result = JSON.parse((await launch(['verify', item.file, '--source-root', item.sourceRoot])).stdout)
          assert.equal(result.fingerprint, item.review.snapshot.fingerprint)
        })
      }
    }
    const artifact = {
      measuredAt: new Date().toISOString(), runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
      package: { version, archive: archivePath, cliBytes: extracted.stdout.byteLength, cliSha256: sha256(extracted.stdout), archiveSha256: sha256(await readFile(archive)) },
      method: { unit: 'milliseconds', sequential: true, filesystemCache: 'warm or uncontrolled; no cache eviction', service: 'temporary owned daemon and GET-only loopback stub; no live sessions read or written',
        processCpu: 'current benchmark process only; provided for in-process operations, not child CLI processes',
        daemonColdStart: 'daemon stopped between samples; first launch creates a registry, subsequent samples reuse the saved port and registry',
        sourceFixture: 'synthetic UTF-8 comments, 128-byte LF lines; each evidence reference hashes line 1; fixture creation is outside timed regions',
        getResponseBytes: Buffer.byteLength(responseBody), waitLongPollMs: 25000,
        llm: 'Not measured: actual diagram generation, code/document edits, response generation, model/tool latency and human review time.' },
      fixtures: cases.map(({ name, totalBytes, fileCount, evidenceCount }) => ({ name, totalBytes, fileCount, evidenceCount })), measurements,
    }
    const output = join(root, 'artifacts/performance/cli.json')
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(JSON.stringify({ output: 'artifacts/performance/cli.json', measurements: Object.keys(measurements).length }, null, 2))
  } finally {
    await launch(['server', 'stop']).catch(() => {})
    await closeServer?.()
    await rm(temporary, { recursive: true, force: true })
  }
}

await main()
