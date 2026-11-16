import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { goBinary } from './go-process.mjs'
import { sampleReview } from '../src/sample.ts'
const execute = promisify(execFile)

test('native stdio starts on tool call, shares one writer and recovers in the same connection', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-lazy-'))
  const home = join(directory, 'home'), data = join(directory, 'sessions')
  await mkdir(home); await mkdir(data)
  const env = { ...process.env, LOGIC_MARGIN_HOME: home, LOGIC_MARGIN_DATA_DIR: data, LOGIC_MARGIN_URL: 'http://127.0.0.1:1' }
  const clients = []
  t.after(async () => {
    for (const client of clients) await client.close()
    await execute(goBinary, ['server', 'stop'], { env })
    await rm(directory, { recursive: true, force: true })
  })
  const connect = async () => {
    const client = new Client({ name: 'lazy-native-test', version: '1' }, { capabilities: {} })
    clients.push(client)
    await client.connect(new StdioClientTransport({ command: goBinary, args: ['mcp'], env, stderr: 'ignore' }))
    assert.equal((await client.listTools()).tools.length, 11)
    return client
  }
  const one = await connect(), two = await connect()
  await assert.rejects(access(join(home, 'daemon.json')), { code: 'ENOENT' })
  const list = client => client.callTool({ name: 'list_reviews', arguments: { state: 'all' } })
  for (const result of await Promise.all([list(one), list(two)])) assert.notEqual(result.isError, true)
  const before = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8'))
  assert.equal(before.dataDir, data)
  const same = JSON.parse((await execute(goBinary, ['server', 'status'], { env })).stdout)
  assert.equal(same.pid, before.pid)
  const created = await fetch(before.url + '/api/review-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: sampleReview }) })
  assert.equal(created.status, 201)
  const saved = await created.json()
  await execute(goBinary, ['server', 'stop'], { env })
  for (const result of await Promise.all([list(one), list(two)])) assert.notEqual(result.isError, true)
  const after = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8'))
  assert.notEqual(after.pid, before.pid)
  assert.equal(after.dataDir, data)
  const read = await one.callTool({ name: 'get_review', arguments: { session_id: saved.id } })
  assert.notEqual(read.isError, true)
  assert.equal(JSON.parse(read.content.find(c => c.type === 'text').text).review.snapshot.fingerprint, saved.review.snapshot.fingerprint)
  await Promise.all(clients.map(client => client.close())); clients.length = 0
  assert.equal(JSON.parse((await execute(goBinary, ['server', 'status'], { env })).stdout).running, true)
})
