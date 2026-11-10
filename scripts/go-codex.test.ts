import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { startGo, goBinary } from './go-process.mjs'
import { sampleReview } from '../src/sample.ts'

const execute = promisify(execFile)
const enabled = process.env.LOGIC_MARGIN_TEST_CODEX_MCP === '1'
const skip = !enabled ? 'set LOGIC_MARGIN_TEST_CODEX_MCP=1 for real Codex transport verification' :
  spawnSync('codex', ['--version'], { stdio: 'ignore' }).status !== 0 ? 'codex CLI is unavailable' : false
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref())

function rpc(child: ChildProcessWithoutNullStreams) {
  let nextId = 0, raw = ''
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const methods: string[] = [], notifications: string[] = []
  const fail = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('isolated Codex App Server closed')) }
    pending.clear()
  }
  child.once('error', fail)
  child.once('close', fail)
  child.stderr.resume()
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    raw += chunk
    let boundary: number
    while ((boundary = raw.indexOf('\n')) >= 0) {
      const line = raw.slice(0, boundary); raw = raw.slice(boundary + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.method === 'string') notifications.push(message.method)
      const entry = typeof message.id === 'number' ? pending.get(message.id) : undefined
      if (!entry) continue
      pending.delete(message.id as number); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`Codex RPC rejected ${JSON.stringify(message.error)}`))
      else entry.resolve(message.result)
    }
  })
  const call = (method: string, params: unknown, timeout = 10000): Promise<unknown> => {
    methods.push(method)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex RPC timeout: ${method}`)) }, timeout)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  return { call, methods, notifications }
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-real-codex-mcp-'))
  const codexHome = join(directory, 'codex')
  await mkdir(codexHome)
  let service
  const children: ChildProcessWithoutNullStreams[] = []
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      child.kill()
      await Promise.race([closed, delay(500)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    }
    await service?.stop()
    await rm(directory, { recursive: true, force: true })
  })
  service = await startGo({ dataDir: join(directory, 'sessions'), cwd: directory })
  const daemon = service.child
  const url = service.url
  const configured = await execute(goBinary, ['server', 'setup'], { cwd: directory,
    env: { ...process.env, LOGIC_MARGIN_HOME: service.home, LOGIC_MARGIN_DATA_DIR: join(directory, 'sessions'), CODEX_HOME: codexHome }, timeout: 15000 })
  assert.equal(object(object(JSON.parse(configured.stdout)).mcp).toolTimeoutSec, 86400)
  const codex = spawn('codex', ['app-server'], { cwd: directory, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(codex)
  const connection = rpc(codex)
  await connection.call('initialize', { clientInfo: { name: 'logic_margin_transport_test', version: '1.0.0' }, capabilities: { experimentalApi: true } })
  codex.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  const started = object(await connection.call('thread/start', { cwd: directory, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: true }))
  const threadId = String(object(started.thread).id)
  let tools: unknown[] = []
  let inspected: unknown
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const status = object(await connection.call('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' }))
    const data = status.data
    assert.ok(Array.isArray(data))
    const server = data.map(object).find(value => value.name === 'logic_margin')
    inspected = data.map(value => {
      const entry = object(value)
      return { name: entry.name, keys: Object.keys(entry), toolType: typeof entry.tools,
        toolKeys: entry.tools && typeof entry.tools === 'object' ? Object.keys(entry.tools).slice(0, 12) : null }
    })
    if (server?.tools && typeof server.tools === 'object') {
      tools = Array.isArray(server.tools) ? server.tools : Object.values(server.tools)
      if (tools.length) break
    }
    await delay(100)
  }
  assert.ok(tools.some(value => object(value).name === 'wait_review'), `real Codex must discover wait_review before calling it: ${JSON.stringify(inspected)}`)
  const tool = (name: string, args: Record<string, unknown>, timeout?: number) => connection.call('mcpServer/tool/call', { threadId, server: 'logic_margin', tool: name, arguments: args }, timeout)
  const listed = object(await tool('list_reviews', { state: 'all' }))
  assert.ok(Array.isArray(listed.content))
  assert.notEqual(listed.isError, true)
  const created = await fetch(`${url}/api/review-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: sampleReview }) })
  assert.equal(created.status, 201)
  const sessionId = String(object(await created.json()).id)
  return { ...connection, url, daemon, threadId, tool, sessionId }
}

test('real Codex discovers HTTP MCP and reports a crashed backend', { skip, timeout: 35000 }, async t => {
  const service = await setup(t)
  const pending = service.tool('wait_review', { session_id: service.sessionId }, 20000).then(value => ({ kind: 'result', value }), error => ({ kind: 'error', message: String(error) }))
  await service.tool('list_reviews', {})
  await delay(100)
  const killedAt = Date.now()
  service.daemon.kill('SIGKILL')
  const outcome = await Promise.race([pending, delay(8000).then(() => ({ kind: 'no-response' }))])
  t.diagnostic(`real Codex crash observation: ${outcome.kind} after ${Date.now() - killedAt}ms`)
  assert.notEqual(outcome.kind, 'no-response', 'Codex did not report a crashed backend within 8 seconds')
  if (outcome.kind === 'result' && 'value' in outcome) assert.equal(object(outcome.value).isError, true)
  await service.call('thread/loaded/list', {})
  assert.ok(!service.methods.includes('turn/start'))
  assert.ok(!service.notifications.some(method => method === 'turn/started'))
})

test('real Codex waits beyond its default timeout without generating a model turn', { skip, timeout: 100000 }, async t => {
  const service = await setup(t)
  const began = Date.now()
  let ended = false
  const pending = service.tool('wait_review', { session_id: service.sessionId }, 85000).then(value => { ended = true; return value })
  const result = pending.then(value => ({ value }), error => ({ error }))
  await delay(65000)
  assert.equal(ended, false, 'wait_review returned before the human submitted a review')
  const finish = await fetch(`${service.url}/api/review-sessions/${service.sessionId}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'approval', expectedVersion: 1 }) })
  assert.equal(finish.status, 200)
  const outcome = await result
  if ('error' in outcome) throw outcome.error
  const returned = object(outcome.value)
  assert.notEqual(returned.isError, true)
  assert.ok(Array.isArray(returned.content))
  const text = returned.content.map(object).filter(value => value.type === 'text').map(value => String(value.text)).join('\n')
  assert.equal(object(JSON.parse(text)).approved, true)
  assert.ok(Date.now() - began >= 65000)
  assert.ok(!service.methods.includes('turn/start'))
  assert.ok(!service.notifications.some(method => method === 'turn/started'))
  t.diagnostic(`real Codex held one tool call for ${Date.now() - began}ms; no turn/start was sent`)
})


test('real Codex setup preserves unrelated TOML and is idempotent', { skip, timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-real-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const codexHome = join(directory, 'codex')
  await mkdir(codexHome)
  const config = join(codexHome, 'config.toml')
  await writeFile(config, '# Preserve this comment\nmodel = "preserved-test-model"\n[mcp_servers.kept]\nurl = "http://127.0.0.1:50124/mcp"\n')
  const service = await startGo({ dataDir: join(directory, 'sessions') })
  t.after(() => service.stop())
  const run = () => execute(goBinary, ['server', 'setup'], { cwd: directory, timeout: 15000,
    env: { ...process.env, CODEX_HOME: codexHome, LOGIC_MARGIN_HOME: service.home, LOGIC_MARGIN_DATA_DIR: join(directory, 'sessions') } })
  assert.equal(JSON.parse((await run()).stdout).mcp.toolTimeoutSec, 86400)
  const first = await readFile(config, 'utf8')
  for (const value of ['# Preserve this comment', 'model = "preserved-test-model"', '[mcp_servers.kept]', '[mcp_servers.logic_margin]', 'tool_timeout_sec = 86400']) assert.ok(first.includes(value))
  assert.equal(JSON.parse((await run()).stdout).mcp.reloadRequired, true)
  assert.equal(await readFile(config, 'utf8'), first)
})
