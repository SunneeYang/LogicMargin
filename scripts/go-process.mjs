// Process orchestration only: all service, storage and CLI semantics live in Go.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { hostTarget, root } from './build-go.mjs'

export const goBinary = resolve(process.env.LOGIC_MARGIN_GO_BINARY ?? join(root, 'artifacts/go', hostTarget,
  process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin'))

export async function within(promise, ms, message) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}

export async function startGo({ binary = goBinary, dataDir, port = 0, cwd = root, env = process.env, signal } = {}) {
  assert.ok(dataDir, 'Go service requires an explicit data directory')
  const home = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-foreground-'))
  if (signal?.aborted) { await rm(home, { recursive: true, force: true }); signal.throwIfAborted() }
  const instanceId = randomUUID(), token = randomUUID()
  const child = spawn(binary, ['_serve', '--home', home, '--data-dir', resolve(dataDir), '--host', '127.0.0.1', '--port', String(port),
    '--instance-id', instanceId, '--shutdown-token', token], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', spawnError
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-16000) })
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; resolve({ code: 1 }) })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const lines = createInterface({ input: child.stdout })
  let url, closed
  const stop = () => closed ??= (async () => {
    try {
      if (child.exitCode === null && child.signalCode === null && !spawnError) {
        if (!url) child.kill('SIGTERM')
        if (url) await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'X-Logic-Margin-Token': token }, signal: AbortSignal.timeout(2000) }).catch(() => {})
        try { await within(exited, 5000, 'Go shutdown timed out') }
        catch {
          child.kill('SIGTERM')
          try { await within(exited, 2000, 'Go termination timed out') }
          catch { child.kill('SIGKILL'); await within(exited, 2000, 'Go process did not exit') }
        }
      }
    } finally { signal?.removeEventListener('abort', abort); lines.close(); await rm(home, { recursive: true, force: true }) }
  })()
  const abort = () => { if (url) void stop(); else child.kill('SIGTERM') }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const ready = await within(new Promise((resolve, reject) => {
      lines.once('line', line => { try { resolve(JSON.parse(line)) } catch (error) { reject(error) } })
      exited.then(() => reject(spawnError ?? new Error(stderr || 'Go exited before readiness')))
    }), 15000, 'Go startup timed out')
    assert.equal(ready.pid, child.pid)
    assert.equal(ready.instanceId, instanceId)
    const address = new URL(ready.url)
    assert.equal(address.protocol, 'http:'); assert.equal(address.hostname, '127.0.0.1')
    assert.equal(address.pathname, '/'); assert.ok(Number(address.port) > 0)
    url = ready.url
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.pid, child.pid); assert.equal(health.instanceId, instanceId); assert.equal(health.service, 'logic-margin')
    return { url, child, exited, stop, home, instanceId, token, get stderr() { return stderr } }
  } catch (error) { await stop(); throw error }
}

// Create/prewarm happens on a separate process. Copy only authoritative JSON;
// the measured process gets neither memory nor derived disk caches.
export async function seedGoSessions(reviews, dataDir, binary = goBinary) {
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-seed-'))
  let service
  try {
    const seedData = join(temporary, 'sessions')
    service = await startGo({ binary, dataDir: seedData, cwd: temporary })
    const states = []
    for (const review of reviews) {
      const response = await fetch(`${service.url}/api/review-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review }), signal: AbortSignal.timeout(30000) })
      const state = await response.json()
      assert.equal(response.status, 201, JSON.stringify(state)); states.push(state)
    }
    await service.stop()
    await mkdir(dataDir, { recursive: true })
    for (const state of states) await cp(join(seedData, `${state.id}.json`), join(dataDir, `${state.id}.json`), { errorOnExist: true, force: false })
    return states
  } finally { await service?.stop(); await rm(temporary, { recursive: true, force: true }) }
}
