import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify, stripVTControlCharacters } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createServer as createViteServer, preview } from 'vite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { root } from './build-go.mjs'
import { startGo, within } from './go-process.mjs'
import { sampleReview } from '../src/sample.ts'

const execute = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')

test('dev and preview preserve MCP locality and early Go rejections', { timeout: 30000 }, async t => {
  const remote = Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal)?.address
  if (!remote) { t.skip('A non-loopback IPv4 interface is required'); return }
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-proxy-boundary-'))
  let service, vite
  const previous = process.env.LOGIC_MARGIN_GO_TARGET
  const closeVite = async () => {
    if (!vite) return
    if ('close' in vite) await vite.close()
    else { vite.httpServer.closeAllConnections(); await new Promise(resolve => vite.httpServer.close(resolve)) }
    vite = undefined
  }
  t.after(async () => {
    try { await closeVite() }
    finally { try { await service?.stop() } finally { await rm(directory, { recursive: true, force: true }) } }
    if (previous === undefined) delete process.env.LOGIC_MARGIN_GO_TARGET
    else process.env.LOGIC_MARGIN_GO_TARGET = previous
  })
  service = await startGo({ dataDir: join(directory, 'sessions') })
  process.env.LOGIC_MARGIN_GO_TARGET = service.url
  await mkdir(join(directory, 'dist'))
  await writeFile(join(directory, 'dist/index.html'), '<html>preview</html>')
  for (const mode of ['dev', 'preview']) {
    const options = { host: '0.0.0.0', port: 0, strictPort: true }
    vite = mode === 'dev' ? await createViteServer({ root, server: options }) :
      await preview({ root, build: { outDir: join(directory, 'dist') }, preview: options })
    if (mode === 'dev') await vite.listen()
    const port = vite.httpServer.address().port
    const initialize = host => new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'proxy-boundary', version: '1' },
      } })
      const req = request({ host, localAddress: host, port, path: '/mcp', method: 'POST', headers: {
        Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '127.0.0.1', 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      } }, response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode, sessionId: response.headers['mcp-session-id'] })) })
      req.once('error', reject)
      req.setTimeout(5000, () => req.destroy(new Error('MCP proxy request timed out')))
      req.end(body)
    })
    const denied = await initialize(remote)
    assert.equal(denied.status, 403, `${mode} accepted a non-loopback client`)
    assert.equal(denied.sessionId, undefined)
    const accepted = await initialize('127.0.0.1')
    assert.equal(accepted.status, 200, `${mode} rejected a local client`)
    assert.ok(accepted.sessionId, `${mode} did not initialize the actual Go MCP transport`)
    for (const padding of ['', 'x'.repeat(230000)]) {
      const requestBody = JSON.stringify({ review: sampleReview, padding })
      assert.ok(Buffer.byteLength(requestBody) < 256 * 1024, 'stay within Go\'s automatic body drain window')
      // Repeat the upload/early-response race without retrying a failed request.
      for (let attempt = 0; attempt < (padding ? 100 : 1); attempt++) {
        const rejected = await fetch(`http://127.0.0.1:${port}/api/review-sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' },
          body: requestBody, signal: AbortSignal.timeout(5000),
        })
        const body = await rejected.text()
        assert.equal(rejected.status, 403, `${mode} lost the upstream rejection: ${body}`)
        assert.equal(JSON.parse(body).error, '拒绝跨域会话写入')
      }
    }
    await closeVite()
  }
})

test('source CLI reports build cancellation as failure', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-cli-cancel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const preload = join(directory, 'cancel-build.mjs')
  await writeFile(preload, "process.on('newListener', name => { if (name === 'SIGTERM') queueMicrotask(() => process.emit('SIGTERM')) })\n")
  await assert.rejects(execute(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/go-cli.mjs', '--version'], {
    cwd: root, env: { ...process.env, LOGIC_MARGIN_HOME: join(directory, 'home'), LOGIC_MARGIN_DATA_DIR: join(directory, 'sessions') }, timeout: 40000,
  }), error => { assert.equal(error.code, 1); assert.equal(error.stdout.trim(), ''); return true })
})

test('foreground helper rejects a second writer and reaps a failed startup', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-process-check-'))
  let service
  t.after(async () => { await service?.stop(); await rm(directory, { recursive: true, force: true }) })
  service = await startGo({ dataDir: directory })
  await assert.rejects(startGo({ dataDir: directory }), /锁|进程|占用/)
  const controller = new AbortController()
  const starting = startGo({ dataDir: join(directory, 'cancelled'), signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(starting)
  const recovered = await startGo({ dataDir: join(directory, 'cancelled') }); await recovered.stop()
  await service.stop()
  assert.throws(() => process.kill(service.child.pid, 0))
})

test('Vite proxies actual Go health/API/MCP and source CLI, preserving origins and cleanup', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-development-check-'))
  const env = { ...process.env, FORCE_COLOR: '1', LOGIC_MARGIN_DATA_DIR: join(directory, 'sessions'), LOGIC_MARGIN_HOME: join(directory, 'unused-managed-home') }
  delete env.LOGIC_MARGIN_URL; delete env.LOGIC_MARGIN_PUBLIC_URL; delete env.NO_COLOR
  const child = spawn(process.execPath, ['scripts/go-dev.mjs', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let raw = '', stderr = '', backendPid, client
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-16000) })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  t.after(async () => {
    await client?.close().catch(() => {})
    if (child.connected) child.send('stop')
    try { await within(exited, 10000, 'dev driver shutdown timeout') }
    catch (error) { child.kill('SIGKILL'); throw error }
    finally { await rm(directory, { recursive: true, force: true }) }
    if (backendPid) assert.throws(() => process.kill(backendPid, 0), 'dev driver leaked its Go subprocess')
  })
  const url = await within(new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', chunk => {
      raw = (raw + chunk).slice(-16000)
      const match = stripVTControlCharacters(raw).match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/)
      if (match) resolve(match[1])
    })
    exited.then(() => reject(new Error(`dev exited before ready: ${stderr}\n${raw}`)), reject)
  }), 90000, 'Vite/Go startup timed out').catch(error => {
    throw new Error(`${error.message}\n${stderr}\n${raw}`, { cause: error })
  })
  assert.notEqual(raw, stripVTControlCharacters(raw), 'dev startup must exercise colored terminal output')
  const health = await (await fetch(`${url}/api/health`)).json()
  assert.equal(health.service, 'logic-margin'); assert.notEqual(health.pid, child.pid)
  assert.match(health.instanceId, /^[a-f0-9-]{36}$/); backendPid = health.pid
  assert.match(await (await fetch(url)).text(), /@vite\/client/)
  client = new Client({ name: 'same-origin-proxy-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Origin: url } } }))
  assert.equal((await client.listTools()).tools.length, 11)
  const review = structuredClone(sampleReview)
  review.nodes.forEach(node => { node.evidence = [] }); review.comments = []
  const content = 'check()\nrun()\n', files = [{ path: 'logic.ts', sha256: sha(content) }]
  review.nodes[0].evidence = [{ path: 'logic.ts', startLine: 1, endLine: 2, symbol: 'check', digest: sha(content.trimEnd()) }]
  review.snapshot.files = files; review.snapshot.fingerprint = sha(JSON.stringify(files))
  await writeFile(join(directory, 'logic.ts'), content)
  const reviewFile = join(directory, 'review.json')
  await writeFile(reviewFile, JSON.stringify(review))
  const cli = args => execute(process.execPath, ['scripts/go-cli.mjs', ...args], { cwd: root, env, timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
  assert.match((await cli(['--help'])).stdout, /server start/)
  assert.equal((await cli(['--version'])).stdout.trim(), JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version)
  const started = JSON.parse((await cli(['start', reviewFile, '--source-root', directory, '--url', url])).stdout)
  const saved = await (await fetch(`${url}/api/review-sessions/${started.sessionId}`, { headers: { Origin: url } })).json()
  assert.equal(saved.review.nodes[0].evidence[0].code, content.trimEnd())
  assert.equal(JSON.parse(await readFile(join(env.LOGIC_MARGIN_DATA_DIR, `${started.sessionId}.json`), 'utf8')).id, started.sessionId)
  const denied = await fetch(`${url}/api/review-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' }, body: JSON.stringify({ review }) })
  assert.equal(denied.status, 403, `${await denied.text()}\n${stderr}`)
  const waitStarted = performance.now()
  const timedOut = await client.callTool({ name: 'wait_review', arguments: { session_id: started.sessionId, timeout_seconds: 6 } })
  assert.equal(timedOut.isError, true)
  assert.match(JSON.stringify(timedOut), /等待审查超时/)
  assert.ok(performance.now() - waitStarted >= 5500, 'proxy ended a long MCP call before its deadline')
  const finished = await fetch(`${url}/api/review-sessions/${started.sessionId}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ kind: 'approval', expectedVersion: saved.version }) })
  assert.equal(finished.status, 200)
  assert.equal(JSON.parse((await cli(['wait', started.sessionId, '--url', url, '--timeout', '2'])).stdout).approved, true)
})
