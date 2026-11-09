#!/usr/bin/env node
// Run via agent-tmp-run: node scripts/benchmark-review-browser.mjs CONFIG.json OUTPUT.json
// variants: [{ name, command: [absoluteExecutable, ...args], identityPaths?: [absolutePath] }]
// Commands are frozen executables/Node entrypoints; this harness appends isolated _serve flags and never builds.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, cpus, freemem, hostname, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performanceReview, performanceSession, performanceSessionId } from '../tests/fixtures/performance-review.ts'
import { parseReview } from '../src/model.ts'
import { validateEvidenceCode } from '../server/publication.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stages = ['cold_navigation', 'reload', 'scene_first_visit', 'baseline_first_visit', 'current_return', 'scene_hot_revisit', 'diff_open_unified', 'diff_switch_split']
const settings = { viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce', deviceScaleFactor: 1 }

function distribution(values) {
  assert.ok(values.length && values.every(Number.isFinite), 'Nonempty finite samples required')
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return { n: values.length, median: percentile(.5), p95: percentile(.95), min: sorted[0], max: sorted.at(-1), raw: values }
}

function validateFixture() {
  const review = parseReview(performanceReview())
  validateEvidenceCode(review)
  validateEvidenceCode(review.baseline)
  assert.equal(review.scenes.length, 2)
  for (const document of [review, review.baseline]) {
    assert.equal(document.snapshot.fingerprint, hash(JSON.stringify(document.snapshot.files)))
    for (const scene of document.scenes) {
      const nodes = document.nodes.filter(node => node.sceneId === scene.id)
      assert.equal(nodes.length, document === review ? 45 : 46)
      const edges = document.edges.filter(edge => edge.sceneId === scene.id)
      assert.ok(edges.length > nodes.length)
      assert.ok(edges.some(edge => Number(edge.target.split('-').at(-1)) < Number(edge.source.split('-').at(-1))))
      const evidence = nodes[0].evidence[0]
      assert.ok(evidence.endLine > 900 && evidence.endLine <= 2000)
      assert.ok(evidence.code.length <= 100000)
      assert.equal(hash(evidence.code), document.snapshot.files[0].sha256)
    }
    for (const evidence of document.nodes.flatMap(node => node.evidence)) {
      assert.equal(evidence.digest, hash(evidence.code))
      assert.equal(evidence.endLine - evidence.startLine + 1, evidence.code.split('\n').length)
    }
  }
  assert.notEqual(review.nodes[0].evidence[0].code, review.baseline.nodes[0].evidence[0].code)
  return review
}

// Same nearest-rank quantiles as perf-server.ts (with explicit even-size behavior).
if (process.argv[2] === '--self-test') {
  assert.deepEqual(distribution([5, 1, 4, 2, 3]), { n: 5, median: 3, p95: 5, min: 1, max: 5, raw: [5, 1, 4, 2, 3] })
  assert.equal(distribution([4, 1, 3, 2]).median, 2)
  assert.equal(distribution(Array.from({ length: 20 }, (_, i) => i + 1)).p95, 19)
  assert.throws(() => distribution([]))
  assert.throws(() => distribution([NaN]))
  const review = validateFixture()
  const { authoredPositions, routeGraphEdges } = await import('../src/graph-routing.ts')
  for (const document of [review, review.baseline]) for (const scene of document.scenes) {
    const nodes = document.nodes.filter(node => node.sceneId === scene.id), edges = document.edges.filter(edge => edge.sceneId === scene.id)
    for (const size of [{ width: 248, height: 160 }, { width: 320, height: 268 }]) {
      const placed = authoredPositions(nodes, edges, new Map(nodes.map(node => [node.id, size])))
      assert.ok(placed)
      const routed = routeGraphEdges(placed, edges, new Map(nodes.map(node => [node.id, node.kind])))
      assert.equal(routed.size, edges.length)
      for (const route of routed.values()) assert.ok(route.points.every((point, index) => !index || point.x === route.points[index - 1].x || point.y === route.points[index - 1].y))
    }
  }
  assert.equal(JSON.stringify(performanceSession()), JSON.stringify(performanceSession()))
  console.log('PASS: fixture evidence/manifests/topology/limits, deterministic session bytes, median/p95')
} else {
  assert.equal(process.argv.length, 4, 'Usage: node scripts/benchmark-review-browser.mjs CONFIG.json OUTPUT.json (or --self-test)')
  await main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1 })
}

async function commandIdentity(variant) {
  const files = new Map()
  async function visit(path) {
    path = await realpath(path)
    if (files.has(path)) return
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!['node_modules', '.git', '.scratch'].includes(name)) await visit(join(path, name))
      }
      return
    }
    const bytes = await readFile(path)
    files.set(path, { path, bytes: bytes.length, sha256: hash(bytes) })
    // Identify transitive local Node sources, including a frozen wrapper's absolute file: imports.
    if (/\.(mjs|cjs|js|ts)$/.test(path)) {
      for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*\(?)["']((?:\.\.?\/|file:\/\/\/)[^"']+)["']/g)) {
        const imported = match[1].startsWith('file:') ? fileURLToPath(match[1]) : resolve(dirname(path), match[1])
        await visit(imported)
      }
    }
  }
  for (const path of [...variant.command.filter(isAbsolute), ...(variant.identityPaths ?? [])]) await visit(path)
  const artifacts = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  return { command: variant.command, identityPaths: variant.identityPaths ?? [], artifacts, sha256: hash(JSON.stringify(artifacts)) }
}

function browserInstrumentation(expected) {
  localStorage.setItem('logic-margin:language', 'zh-CN')
  localStorage.setItem('logic-margin:appearance', JSON.stringify({ theme: 'paper', mode: 'light' }))
  const state = window.__reviewBenchmark = { results: [], longTasks: [], activeStage: null }
  performance.setResourceTimingBufferSize(5000)
  new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true })
  function graphSignature(spec) {
    const canvas = document.querySelector('.canvas[data-viewport-ready="true"]')
    if (!canvas) return null
    const version = [...document.querySelectorAll('.revision-switch button')].find(button => button.textContent.trim() === (spec.baseline ? '基线 B' : '当前 R1'))
    if (version?.getAttribute('aria-pressed') !== 'true') return null
    const nodes = [...canvas.querySelectorAll('.react-flow__node')]
    const edges = [...canvas.querySelectorAll('.react-flow__edge')]
    if (nodes.length !== spec.nodeIds.length || edges.length !== spec.edgeIds.length) return null
    if (JSON.stringify(nodes.map(node => node.dataset.id).sort()) !== JSON.stringify(spec.nodeIds)) return null
    if (JSON.stringify(edges.map(edge => edge.dataset.id).sort()) !== JSON.stringify(spec.edgeIds)) return null
    const paths = edges.map(edge => edge.querySelector('.react-flow__edge-path')?.getAttribute('d'))
    if (paths.some(path => !path || !path.includes('L'))) return null
    if (nodes.some(node => !node.offsetWidth || !node.offsetHeight)) return null
    return JSON.stringify([canvas.querySelector('.react-flow__viewport')?.style.transform,
      nodes.map(node => [node.dataset.id, node.style.transform, node.offsetWidth, node.offsetHeight]), paths])
  }
  function diffSignature(spec) {
    const panel = document.querySelector('[data-composer][data-state="open"]')
    if (!panel || panel.querySelector('.discussion-target')?.textContent !== spec.title) return null
    const body = panel.querySelector('.code-evidence-body')
    if (body?.dataset.codeLayout !== (spec.split ? 'split' : 'unified')) return null
    const editors = [...body.querySelectorAll('.cm-editor')]
    if (editors.length !== (spec.split ? 2 : 1)) return null
    if (editors.some(editor => !editor.querySelector('.cm-content[contenteditable="false"][aria-readonly="true"]')?.textContent?.trim())) return null
    const markers = [...body.querySelectorAll('.cm-changedLine,.cm-deletedLine,.cm-insertedLine,.cm-changedText,.cm-deletedText,.cm-insertedText')]
    const summary = body.querySelector('.code-editor-tools [role="status"]')?.textContent
    if (!markers.length || !/^\d+ 处差异$/.test(summary ?? '') || parseInt(summary) < 1) return null
    return JSON.stringify([editors.map(editor => [editor.offsetWidth, editor.offsetHeight, editor.querySelector('.cm-content').textContent]), markers.map(marker => marker.className)])
  }
  state.run = (spec, navigation = false) => new Promise((resolve, reject) => {
    const startTime = navigation ? 0 : performance.now()
    state.activeStage = spec.name
    let previous, stable = 0, tabClicked = false, lastSignature = null
    const timer = setTimeout(() => reject(new Error(`Readiness timed out: ${spec.name}; graph nodes=${document.querySelectorAll('.react-flow__node').length}, edges=${document.querySelectorAll('.react-flow__edge').length}, editors=${document.querySelectorAll('.cm-editor').length}`)), 45000)
    const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text)
    function tick() {
      if (spec.name === 'diff_open_unified' && !tabClicked) {
        const tab = [...document.querySelectorAll('[data-composer][data-state="open"] [role="tab"]')].find(element => element.textContent.trim() === '代码 diff')
        if (tab) { tabClicked = true; tab.click() }
      }
      const signature = document.fonts.status === 'loaded' ? spec.diff ? diffSignature(spec) : graphSignature(spec) : null
      lastSignature = signature
      stable = signature && signature === previous ? stable + 1 : 0
      previous = signature
      // Two complete RAF intervals with identical geometry/content after readiness first becomes true.
      if (stable >= 2) {
        clearTimeout(timer)
        const endTime = performance.now()
        const result = { stage: spec.name, startTime, endTime, durationMs: endTime - startTime, readySignatureSHAInput: lastSignature,
          actualNodes: document.querySelectorAll('.react-flow__node').length, actualEdges: document.querySelectorAll('.react-flow__edge').length,
          actualEditors: document.querySelectorAll('[data-composer][data-state="open"] .cm-editor').length }
        state.results.push(result); state.activeStage = null; resolve(result)
      } else requestAnimationFrame(tick)
    }
    try {
      if (spec.sceneIndex !== undefined) document.querySelectorAll('.scene-button')[spec.sceneIndex].click()
      else if (spec.button) { const target = button(spec.button); if (!target) throw new Error(`Missing button ${spec.button}`); target.click() }
      else if (spec.name === 'diff_open_unified') document.querySelector(`.react-flow__node[data-id="${spec.nodeId}"] .node-comment-button`).click()
      requestAnimationFrame(tick)
    } catch (error) { clearTimeout(timer); reject(error) }
  })
  state.navigation = state.run(expected, true)
  state.navigation.catch(error => { state.navigationError = error.message })
}

async function startService(variant, directory, sessionBytes, log) {
  const home = join(directory, 'home'), dataDir = join(directory, 'sessions')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(join(dataDir, `${performanceSessionId}.json`), sessionBytes, { mode: 0o600 })
  const instanceId = randomUUID()
  const command = [...variant.command, '_serve', '--home', home, '--data-dir', dataDir, '--host', '127.0.0.1', '--port', '0', '--instance-id', instanceId, '--shutdown-token', randomUUID()]
  const child = spawn(command[0], command.slice(1), { cwd: directory, env: { ...process.env, LOGIC_MARGIN_HOME: home, LOGIC_MARGIN_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
  log.pid = child.pid
  child.stderr.setEncoding('utf8').on('data', data => { log.stderr = ((log.stderr ?? '') + data).slice(-64000) })
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000).then(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL') })])
  }
  try {
    const ready = await new Promise((resolveReady, reject) => {
      let stdout = ''
      const timer = setTimeout(() => reject(new Error('Service startup timeout')), 30000)
      const fail = error => { clearTimeout(timer); reject(error) }
      child.once('error', fail)
      child.once('exit', (code, signal) => fail(new Error(`Service exited ${code ?? signal}: ${log.stderr ?? ''}`)))
      child.stdout.setEncoding('utf8').on('data', data => {
        stdout += data; log.stdout = stdout.slice(-64000)
        if (!stdout.includes('\n')) return
        try { const ready = JSON.parse(stdout.split('\n')[0]); assert.equal(ready.instanceId, instanceId); assert.equal(ready.pid, child.pid); assert.equal(new URL(ready.url).hostname, '127.0.0.1'); clearTimeout(timer); resolveReady(ready) }
        catch (error) { fail(error) }
      })
    })
    return { url: ready.url, stop, command: [...variant.command, '_serve', '<isolated home/data-dir>', '--host', '127.0.0.1', '--port', '0'] }
  } catch (error) { await stop(); throw error }
}

function metricsDelta(before, after) {
  return Object.fromEntries(['ScriptDuration', 'LayoutDuration', 'TaskDuration', 'RecalcStyleDuration'].map(name => [name + 'Ms', ((after[name] ?? 0) - (before[name] ?? 0)) * 1000]))
}

async function sample(browser, variant, directory, sessionBytes, review, journal) {
  const result = { variant: variant.name, stages: [], requests: [], errors: [], service: {}, machineBefore: { loadavg: loadavg(), freeMemoryBytes: freemem() } }
  let service, context
  try {
    service = await startService(variant, directory, sessionBytes, result.service)
    context = await browser.newContext(settings)
    const graph = (name, sceneIndex, baseline = false, action = {}) => {
      const document = baseline ? review.baseline : review, sceneId = document.scenes[sceneIndex].id
      return { name, baseline, nodeIds: document.nodes.filter(node => node.sceneId === sceneId).map(node => node.id).sort(),
        edgeIds: document.edges.filter(edge => edge.sceneId === sceneId).map(edge => edge.id).sort(), ...action }
    }
    await context.addInitScript(browserInstrumentation, graph('cold_navigation', 0))
    const page = await context.newPage()
    page.setDefaultTimeout(45000)
    page.on('pageerror', error => result.errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' || message.text().includes('[React Flow]')) result.errors.push(message.text()) })
    let activeStage = 'cold_navigation'
    const requestEntries = new WeakMap()
    page.on('request', request => {
      const url = new URL(request.url())
      const entry = { stage: activeStage, pathname: url.pathname, query: url.search, method: request.method(), resourceType: request.resourceType(), timing: request.timing(), finished: false }
      requestEntries.set(request, entry)
      result.requests.push(entry)
    })
    page.on('response', response => {
      const request = response.request(), headers = response.headers(), entry = requestEntries.get(request)
      Object.assign(entry, { status: response.status(), timing: request.timing(), fromServiceWorker: response.fromServiceWorker(),
        headers: Object.fromEntries(['cache-control', 'etag', 'last-modified', 'age', 'vary', 'content-encoding', 'content-length', 'x-logic-margin-cache'].filter(name => headers[name] !== undefined).map(name => [name, headers[name]])) })
      if (response.status() >= 400) result.errors.push(`HTTP ${response.status()} ${entry.pathname}`)
    })
    page.on('requestfinished', request => Object.assign(requestEntries.get(request), { timing: request.timing(), finished: true }))
    page.on('requestfailed', request => {
      Object.assign(requestEntries.get(request), { timing: request.timing(), failure: request.failure()?.errorText })
      if (request.failure()?.errorText !== 'net::ERR_ABORTED') result.errors.push(`${request.url()}: ${request.failure()?.errorText}`)
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]))
    async function phase(name, operation, navigation = false) {
      activeStage = name
      const before = navigation ? {} : await metrics(), wallStart = performance.now()
      const measured = await operation()
      const after = await metrics()
      measured.stage = name
      measured.readySignatureSHA256 = hash(measured.readySignatureSHAInput)
      delete measured.readySignatureSHAInput
      result.stages.push({ ...measured, automationWallMs: performance.now() - wallStart, mainThread: metricsDelta(before, after) })
      await journal({ type: 'stage', variant: variant.name, ...result.stages.at(-1) })
    }
    const navigation = async reload => {
      if (reload) await page.reload({ waitUntil: 'commit' })
      else await page.goto(`${service.url}/?session=${performanceSessionId}`, { waitUntil: 'commit' })
      return page.evaluate(() => window.__reviewBenchmark.navigation)
    }
    await phase('cold_navigation', () => navigation(false), true)
    result.coldDocument = await page.evaluate(() => ({ navigation: performance.getEntriesByType('navigation')[0].toJSON(), resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()), longTasks: window.__reviewBenchmark.longTasks }))
    await phase('reload', () => navigation(true), true)
    const action = spec => page.evaluate(spec => window.__reviewBenchmark.run(spec), spec)
    await phase('scene_first_visit', () => action(graph('scene_first_visit', 1, false, { sceneIndex: 1 })))
    await phase('baseline_first_visit', () => action(graph('baseline_first_visit', 1, true, { button: '基线 B' })))
    await phase('current_return', () => action(graph('current_return', 1, false, { button: '当前 R1' })))
    await phase('scene_hot_revisit', () => action(graph('scene_hot_revisit', 0, false, { sceneIndex: 0 })))
    const node = review.nodes.find(node => node.sceneId === review.scenes[0].id)
    const diff = { diff: true, nodeId: node.id, title: node.title }
    await phase('diff_open_unified', () => action({ ...diff, name: 'diff_open_unified', split: false }))
    await phase('diff_switch_split', () => action({ ...diff, name: 'diff_switch_split', split: true, button: '并排' }))
    const detail = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      return { longTasks: window.__reviewBenchmark.longTasks, resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()), domNodes: document.querySelectorAll('*').length,
        userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency }
    })
    result.document = detail
    for (const stage of result.stages) {
      const tasks = stage.stage === 'cold_navigation' ? result.coldDocument.longTasks : detail.longTasks
      stage.longTasks = tasks.filter(task => task.startTime < stage.endTime && task.startTime + task.duration > stage.startTime)
      stage.longTaskCount = stage.longTasks.length
      stage.longTaskTotalMs = stage.longTasks.reduce((sum, task) => sum + Math.min(stage.endTime, task.startTime + task.duration) - Math.max(stage.startTime, task.startTime), 0)
      stage.longTaskMaxMs = Math.max(0, ...stage.longTasks.map(task => task.duration))
      const resources = stage.stage === 'cold_navigation' ? result.coldDocument.resources : detail.resources
      stage.resources = resources.filter(resource => resource.startTime >= stage.startTime && resource.startTime <= stage.endTime)
      stage.precomputeRequests = stage.resources.filter(resource => new URL(resource.name).pathname.includes('/precompute'))
      stage.resourceRequestCount = stage.resources.length
      stage.precomputeRequestCount = stage.precomputeRequests.length
    }
    assert.equal(result.errors.length, 0, result.errors.join('\n'))
    const saved = await readFile(join(directory, 'sessions', `${performanceSessionId}.json`))
    assert.equal(hash(saved), hash(sessionBytes), 'Reading benchmark must not mutate the saved session')
    return result
  } catch (error) { error.sample = result; throw error }
  finally { try { await context?.close() } finally { await service?.stop() } }
}

function summarize(samples, variants) {
  return variants.map(variant => ({ name: variant.name, stages: Object.fromEntries(stages.map(name => {
    const rows = samples.filter(sample => sample.variant === variant.name).map(sample => sample.stages.find(stage => stage.stage === name))
    return [name, Object.fromEntries(['durationMs', 'automationWallMs', 'longTaskTotalMs', 'longTaskMaxMs', 'longTaskCount', ...['ScriptDuration', 'LayoutDuration', 'TaskDuration', 'RecalcStyleDuration'].map(name => name + 'Ms')].map(metric => [metric, distribution(rows.map(row => row[metric] ?? row.mainThread[metric]))]))]
  })) }))
}

async function main() {
  const configPath = resolve(process.argv[2]), outputPath = resolve(process.argv[3])
  const configBytes = await readFile(configPath), config = JSON.parse(configBytes)
  const rounds = config.rounds ?? 7
  assert.ok(Number.isInteger(rounds) && rounds >= 5, 'rounds must be an integer >= 5')
  assert.ok(Array.isArray(config.variants) && config.variants.length >= 2, 'At least two variants required')
  assert.equal(new Set(config.variants.map(variant => variant.name)).size, config.variants.length, 'Unique variant names required')
  for (const variant of config.variants) {
    assert.ok(typeof variant.name === 'string' && variant.name.length)
    assert.ok(Array.isArray(variant.command) && variant.command.length && variant.command.every(arg => typeof arg === 'string'))
    assert.ok(isAbsolute(variant.command[0]), 'Use an absolute executable path')
    assert.ok(!variant.command.includes('_serve'), 'Only executable/Node entrypoint belongs in command; _serve flags are supplied by this harness')
    assert.ok((variant.identityPaths ?? []).every(isAbsolute))
  }
  const review = validateFixture(), sessionBytes = Buffer.from(JSON.stringify(performanceSession()))
  assert.ok(sessionBytes.length < 32 * 1024 * 1024)
  await mkdir(dirname(outputPath), { recursive: true })
  const report = { schemaVersion: 1, status: 'running', capturedAt: new Date().toISOString(), configPath, configSHA256: hash(configBytes), runNote: config.note ?? null, rounds,
    methodology: { viewport: settings, theme: 'paper/light', channel: 'chrome', headless: true, cpuThrottling: 'none', networkThrottling: 'none',
      order: 'Round r rotates variant order by r modulo variant count; samples and phases run serially.',
      cold: 'Fresh service process, isolated home/session/derived cache, fresh browser context and HTTP cache. Chrome process reused; OS page cache is not cleared. No HTTP probe/create/get occurs before the timed first navigation.',
      readiness: 'Exact saved node/edge identities, nonempty orthogonal paths, measured node sizes, viewport ready, fonts loaded, geometry unchanged for two full RAF intervals; diff requires target identity, populated read-only CodeMirror editor(s) and change markers stable for two RAF intervals.',
      timing: 'Navigation uses performance.timeOrigin to readiness. Interactions start immediately before DOM click(s) in the page and end at readiness. Diff open includes opening the node window and its code tab. Input device hit testing is excluded. automationWallMs includes Playwright/CDP/journal overhead for comparison, not the primary latency.',
      mainThread: 'CDP Script/Layout/Task/RecalcStyle durations; interaction snapshots bracket automation and include its boundary overhead. Navigation metrics start from the new document zero. LongTask totals clip overlapping entries to each phase; max reports full overlapping task length. Resource timings/encoded/decoded/transfer sizes use browser performance entries; event-driven request timings/cache headers use Playwright and retain unfinished/cancelled long polls without waiting for them.',
      boundaries: ['Desktop localhost Chrome only; no real phone, OS cache flush, CPU/network throttling or server-only attribution.', 'First scene visit, baseline first visit, current return, hot scene revisit and first diff open are separate stages.', 'The cold session read includes source validation/serialization; fixture is seeded once and copied byte-for-byte before every process launch.', 'No build, service registry outside isolated home, global settings, or production service is used.', 'Small n p95 is a nearest-rank order statistic, not a confidence interval.'] },
    machine: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), loadavg: loadavg(), node: process.version, nodeExecutable: process.execPath, runnerPID: process.pid },
    harness: { scriptSHA256: hash(await readFile(fileURLToPath(import.meta.url))), fixtureSourceSHA256: hash(await readFile(join(root, 'tests/fixtures/performance-review.ts'))) },
    fixture: { snapshotPath: outputPath + '.session.json', sessionId: performanceSessionId, bytes: sessionBytes.length, sha256: hash(sessionBytes), scenes: review.scenes.map(scene => ({ id: scene.id, currentNodes: review.nodes.filter(node => node.sceneId === scene.id).length, currentEdges: review.edges.filter(edge => edge.sceneId === scene.id).length, baselineNodes: review.baseline.nodes.filter(node => node.sceneId === scene.id).length, baselineEdges: review.baseline.edges.filter(edge => edge.sceneId === scene.id).length })), sources: [review.baseline.snapshot, review.snapshot], longEvidence: [review.baseline, review].map(document => ({ revision: document.revision, lines: document.nodes[0].evidence[0].endLine, utf16: document.nodes[0].evidence[0].code.length, sha256: document.nodes[0].evidence[0].digest })) },
    variants: [], samples: [] }
  await writeFile(outputPath, JSON.stringify(report, null, 2), { flag: 'wx' })
  await writeFile(report.fixture.snapshotPath, sessionBytes, { flag: 'wx', mode: 0o600 })
  const journal = entry => appendFile(outputPath + '.events.jsonl', JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'review-browser-benchmark-'))
  let browser
  let interrupted = false
  const interrupt = () => { interrupted = true; void browser?.close().catch(() => {}) }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    for (const variant of config.variants) report.variants.push({ name: variant.name, ...await commandIdentity(variant) })
    let require = createRequire(import.meta.url), playwright
    try { playwright = require('@playwright/test') }
    catch {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
      require = createRequire(join(dirname(resolve(root, common)), 'package.json'))
      playwright = require('@playwright/test')
    }
    report.browser = { playwrightVersion: require('@playwright/test/package.json').version }
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true })
    report.browser.version = browser.version()
    for (let round = 0; round < rounds; round++) {
      for (let offset = 0; offset < config.variants.length; offset++) {
        const variant = config.variants[(round + offset) % config.variants.length]
        assert.ok(!interrupted, 'Benchmark interrupted')
        const directory = join(temporary, `round-${round}-${offset}`)
        await mkdir(directory)
        await journal({ type: 'sample-start', round: round + 1, offset, variant: variant.name })
        const measured = await sample(browser, variant, directory, sessionBytes, review, journal)
        report.samples.push({ round: round + 1, offset, ...measured })
        await writeFile(outputPath, JSON.stringify(report, null, 2))
        await journal({ type: 'sample-complete', round: round + 1, variant: variant.name })
        console.log(JSON.stringify({ round: round + 1, variant: variant.name, durationMs: Object.fromEntries(measured.stages.map(stage => [stage.stage, Math.round(stage.durationMs)])) }))
        await rm(directory, { recursive: true, force: true })
      }
    }
    for (const [index, variant] of config.variants.entries()) assert.equal((await commandIdentity(variant)).sha256, report.variants[index].sha256, `${variant.name} command/source artifacts changed during measurement`)
    report.summary = summarize(report.samples, config.variants)
    report.status = 'complete'
    report.completedAt = new Date().toISOString()
    console.log(`Saved ${outputPath}`)
  } catch (error) {
    report.status = 'failed'; report.failure = { message: error.stack ?? String(error), partialSample: error.sample }
    await journal({ type: 'failure', ...report.failure })
    throw error
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
    await writeFile(outputPath, JSON.stringify(report, null, 2))
    await browser?.close()
    await rm(temporary, { recursive: true, force: true })
  }
}
