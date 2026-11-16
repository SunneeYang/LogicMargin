import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, chmod, cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { goBinary } from './go-process.mjs'
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
  const codexHome = join(directory, 'codex home with spaces')
  const home = join(directory, 'daemon home'), data = join(directory, 'sessions')
  const env = { ...process.env, CODEX_HOME: codexHome, LOGIC_MARGIN_HOME: home, LOGIC_MARGIN_DATA_DIR: data }
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
    await execute(goBinary, ['server', 'stop'], { env, timeout: 15000 })
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(codexHome)
  await writeFile(join(codexHome, 'config.toml'), '# Preserve this comment\n')
  const original = join(directory, 'original marketplace')
  const moved = join(directory, 'moved marketplace with spaces')
  const plugin = join(original, 'plugins/logic-margin')
  await cp(new URL('../plugins/logic-margin/', import.meta.url), plugin, { recursive: true })
  await mkdir(join(original, '.agents/plugins'), { recursive: true })
  await cp(new URL('../.agents/plugins/marketplace.json', import.meta.url), join(original, '.agents/plugins/marketplace.json'))
  const executable = process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin'
  await cp(goBinary, join(plugin, 'skills/logic-margin/scripts', executable))
  await chmod(join(plugin, 'skills/logic-margin/scripts', executable), 0o755)
  // Windows platform ZIPs use their native entry instead of the Unix Git launcher.
  if (process.platform === 'win32') {
    const file = join(plugin, 'mcp.json')
    const config = JSON.parse(await readFile(file, 'utf8'))
    config.mcpServers.logic_margin.command = './skills/logic-margin/scripts/logic-margin.exe'
    config.mcpServers.logic_margin.args = ['mcp']
    await writeFile(file, JSON.stringify(config))
  }
  await rename(original, moved)
  await assert.rejects(access(original), { code: 'ENOENT' })
  const add = await execute('codex', ['plugin', 'marketplace', 'add', moved, '--json'], { cwd: directory, env, timeout: 15000 })
  assert.equal(object(JSON.parse(add.stdout)).marketplaceName, 'logic-margin-local')
  const installed = object(JSON.parse((await execute('codex', ['plugin', 'add', 'logic-margin@logic-margin-local', '--json'], { cwd: directory, env, timeout: 15000 })).stdout))
  assert.equal(installed.name, 'logic-margin')
  const installedPath = String(installed.installedPath)
  const bundled = object(object(JSON.parse(await readFile(join(installedPath, 'mcp.json'), 'utf8'))).mcpServers)
  const entry = object(bundled.logic_margin)
  assert.equal(entry.cwd, '.')
  assert.equal(entry.tool_timeout_sec, 86400)
  assert.ok(!String(entry.command).includes(original) && !String(entry.command).includes(moved))
  const configured = await readFile(join(codexHome, 'config.toml'), 'utf8')
  assert.ok(configured.includes('# Preserve this comment'))
  assert.doesNotMatch(configured, /\[mcp_servers\.logic_margin\]/)
  assert.doesNotMatch(configured, /^\s*(?:command|url)\s*=/m)
  const codex = spawn('codex', ['app-server'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(codex)
  const connection = rpc(codex)
  await connection.call('initialize', { clientInfo: { name: 'logic_margin_transport_test', version: '1.0.0' }, capabilities: { experimentalApi: true } })
  codex.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  const started = object(await connection.call('thread/start', { cwd: directory, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: true }))
  const threadId = String(object(started.thread).id)
  let tools: unknown[] = []
  let inspected: unknown
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const status = object(await connection.call('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' }))
    const servers = status.data
    assert.ok(Array.isArray(servers))
    const server = servers.map(object).find(value => value.name === 'logic_margin')
    inspected = servers.map(value => {
      const item = object(value)
      return { name: item.name, keys: Object.keys(item), toolKeys: item.tools && typeof item.tools === 'object' ? Object.keys(item.tools) : null }
    })
    if (server?.tools && typeof server.tools === 'object') {
      tools = Array.isArray(server.tools) ? server.tools : Object.values(server.tools)
      if (tools.length) break
    }
    await delay(100)
  }
  assert.equal(tools.length, 11, `real Codex must discover the bundled tools: ${JSON.stringify(inspected)}`)
  assert.ok(tools.some(value => object(value).name === 'wait_review'))
  await assert.rejects(access(join(home, 'daemon.json')), { code: 'ENOENT' })
  const tool = (name: string, args: Record<string, unknown>, timeout?: number) => connection.call('mcpServer/tool/call', { threadId, server: 'logic_margin', tool: name, arguments: args }, timeout)
  const listed = object(await tool('list_reviews', { state: 'all' }))
  assert.ok(Array.isArray(listed.content))
  assert.notEqual(listed.isError, true)
  const status = () => execute(goBinary, ['server', 'status'], { env, timeout: 15000 }).then(value => object(JSON.parse(value.stdout)))
  const running = await status()
  assert.equal(running.running, true)
  const url = String(running.url)
  const created = await fetch(`${url}/api/review-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: sampleReview }) })
  assert.equal(created.status, 201)
  const sessionId = String(object(await created.json()).id)
  return { ...connection, url, status, pid: Number(running.pid), threadId, tool, sessionId }
}

test('real Codex loads a moved bundled plugin, starts lazily and recovers after a lost call', { skip, timeout: 45000 }, async t => {
  const service = await setup(t)
  const pending = service.tool('wait_review', { session_id: service.sessionId }, 20000).then(value => ({ kind: 'result', value }), error => ({ kind: 'error', message: String(error) }))
  await service.tool('list_reviews', {})
  await delay(100)
  const killedAt = Date.now()
  assert.ok(Number.isInteger(service.pid) && service.pid > 0)
  process.kill(service.pid, 'SIGKILL')
  const outcome = await Promise.race([pending, delay(8000).then(() => ({ kind: 'no-response' }))])
  t.diagnostic(`real Codex crash observation: ${outcome.kind} after ${Date.now() - killedAt}ms`)
  assert.notEqual(outcome.kind, 'no-response', 'Codex did not report a crashed backend within 8 seconds')
  if (outcome.kind === 'result' && 'value' in outcome) assert.equal(object(outcome.value).isError, true)
  const recovered = object(await service.tool('list_reviews', {}))
  assert.notEqual(recovered.isError, true)
  assert.notEqual((await service.status()).pid, service.pid)
  const saved = object(await service.tool('get_review', { session_id: service.sessionId }))
  assert.notEqual(saved.isError, true)
  await service.call('thread/loaded/list', {})
  assert.ok(!service.methods.includes('turn/start'))
  assert.ok(!service.notifications.some(method => method === 'turn/started'))
})

test('bundled MCP keeps waiting beyond the Codex 300-second default without a model turn', { skip, timeout: 350000 }, async t => {
  const service = await setup(t)
  const began = Date.now()
  let ended = false
  const result = service.tool('wait_review', { session_id: service.sessionId }, 330000).then(value => ({ value }), error => ({ error })).then(value => { ended = true; return value })
  await delay(310000)
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
  assert.ok(Date.now() - began >= 310000)
  assert.ok(!service.methods.includes('turn/start'))
  assert.ok(!service.notifications.some(method => method === 'turn/started'))
  t.diagnostic(`real Codex held one tool call for ${Date.now() - began}ms; no turn/start was sent`)
})


test('server setup remains a start alias and leaves Codex configuration untouched', { skip, timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-real-config-'))
  const codexHome = join(directory, 'codex'), home = join(directory, 'daemon-home')
  const env = { ...process.env, CODEX_HOME: codexHome, LOGIC_MARGIN_HOME: home, LOGIC_MARGIN_DATA_DIR: join(directory, 'sessions') }
  t.after(async () => {
    await execute(goBinary, ['server', 'stop'], { env, timeout: 15000 })
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(codexHome)
  const config = join(codexHome, 'config.toml')
  const original = '# Preserve this comment\nmodel = "preserved-test-model"\n[mcp_servers.kept]\nurl = "http://127.0.0.1:50124/mcp"\n'
  await writeFile(config, original)
  const run = () => execute(goBinary, ['server', 'setup'], { cwd: directory, timeout: 15000, env })
  const first = object(JSON.parse((await run()).stdout))
  assert.equal(first.managed, true)
  assert.equal(first.mcp, undefined)
  assert.equal(await readFile(config, 'utf8'), original)
  const again = object(JSON.parse((await run()).stdout))
  assert.equal(again.url, first.url)
  assert.equal(await readFile(config, 'utf8'), original)
})
