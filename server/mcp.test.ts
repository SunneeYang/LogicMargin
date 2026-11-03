import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createMcpApi } from './mcp.ts'

async function setup(t: TestContext, remote?: string) {
  const events = new EventEmitter()
  const waiting = new Map<string, { signal: AbortSignal; finish(): void }>()
  const api = createMcpApi({ version: '0.6.0', configure(server) {
    server.registerTool('length', { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: String(text.length) }] }))
    server.registerTool('wait', { inputSchema: { key: z.string() } }, async ({ key }, extra) => {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { events.emit('aborted', key); reject(new Error('cancelled')) }
        waiting.set(key, { signal: extra.signal, finish: resolve })
        extra.signal.addEventListener('abort', abort, { once: true })
        events.emit('started', key)
        if (extra.signal.aborted) abort()
      }).finally(() => waiting.delete(key))
      return { content: [{ type: 'text', text: key }] }
    })
  } })
  const server = createServer((incoming, response) => {
    if (remote) Object.defineProperty(incoming.socket, 'remoteAddress', { value: remote })
    void api.handle(incoming, response).catch(error => { response.destroy(error) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/mcp`
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const connect = async () => {
    const client = new Client({ name: 'logic-margin-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url), { reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } })
    await client.connect(transport)
    t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close() })
    return { client, transport }
  }
  const started = async (key: string) => {
    while (!waiting.has(key)) await once(events, 'started', { signal: AbortSignal.timeout(3000) })
    return waiting.get(key)!
  }
  return { url, api, connect, events, waiting, started }
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw-test', version: '1.0.0' } } }
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

test('HTTP MCP clients share one server and keep a tool pending until its result', async t => {
  const service = await setup(t)
  const first = await service.connect(), second = await service.connect()
  assert.notEqual(first.transport.sessionId, second.transport.sessionId)
  assert.deepEqual((await first.client.listTools()).tools.map(tool => tool.name), ['length', 'wait'])
  await first.client.ping()
  const result = first.client.callTool({ name: 'wait', arguments: { key: 'review' } })
  const call = await service.started('review')
  assert.equal(call.signal.aborted, false)
  assert.deepEqual((await second.client.callTool({ name: 'length', arguments: { text: 'still responsive' } })).content, [{ type: 'text', text: '16' }])
  call.finish()
  assert.deepEqual((await result).content, [{ type: 'text', text: 'review' }])
  await first.transport.terminateSession()
  const invalid = await fetch(service.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': first.transport.sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) })
  assert.equal(invalid.status, 404)
  await second.client.ping()
})

test('explicit client cancellation aborts the tool and leaves other sessions usable', async t => {
  const service = await setup(t)
  const { client } = await service.connect()
  const controller = new AbortController()
  const pending = client.callTool({ name: 'wait', arguments: { key: 'cancel' } }, undefined, { signal: controller.signal }).then(() => false, () => true)
  const call = await service.started('cancel')
  const aborted = once(service.events, 'aborted', { signal: AbortSignal.timeout(3000) })
  controller.abort()
  await aborted
  assert.equal(await pending, true)
  assert.equal(call.signal.aborted, true)
  const second = await service.connect()
  await second.client.ping()
})

test('disconnecting a pending POST cancels its handler without leaving an orphan wait', async t => {
  const service = await setup(t)
  const { transport } = await service.connect()
  const controller = new AbortController()
  const response = fetch(service.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }, body: JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'wait', arguments: { key: 'disconnect' } } }), signal: controller.signal }).then(async result => { await result.text() }).catch(() => {})
  const call = await service.started('disconnect')
  const aborted = once(service.events, 'aborted', { signal: AbortSignal.timeout(3000) })
  controller.abort()
  await response
  await aborted
  assert.equal(call.signal.aborted, true)
})

test('service shutdown cancels waiting tools and rejects new connections', async t => {
  const service = await setup(t)
  const { client } = await service.connect()
  const pending = client.callTool({ name: 'wait', arguments: { key: 'shutdown' } }, undefined, { timeout: 30000 }).then(() => false, () => true)
  const call = await service.started('shutdown')
  await service.api.close()
  assert.equal(call.signal.aborted, true)
  assert.equal(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(false), 1000).unref())]), true)
  assert.equal((await fetch(service.url, { method: 'POST', headers, body: JSON.stringify(initialize) })).status, 503)
})

test('HTTP MCP rejects cross-site, non-local and spoofed Host access', async t => {
  const service = await setup(t)
  const rejected: Record<string, string>[] = [{ Origin: 'https://external.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'external.example' }, { Host: '127.0.0.1.external.example' }]
  for (const extra of rejected) {
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(service.url, { method: 'POST', headers: { ...headers, ...extra } }, incoming => { incoming.resume(); resolve(incoming.statusCode!) })
      outgoing.on('error', reject)
      outgoing.end(JSON.stringify(initialize))
    })
    assert.equal(status, 403, JSON.stringify(extra))
  }
  const remote = await setup(t, '100.64.0.10')
  assert.equal((await fetch(remote.url, { method: 'POST', headers, body: JSON.stringify(initialize) })).status, 403)
  const origin = new URL(service.url).origin
  const local = await fetch(service.url, { method: 'POST', headers: { ...headers, Origin: origin }, body: JSON.stringify(initialize) })
  assert.equal(local.status, 200)
  await local.text()
})

test('HTTP MCP rejects invalid sessions and malformed bodies while accepting payloads above the SDK default', async t => {
  const service = await setup(t)
  assert.equal((await fetch(service.url, { method: 'POST', headers, body: '{invalid' })).status, 400)
  assert.equal((await fetch(service.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': 'not-a-session' }, body: JSON.stringify(initialize) })).status, 404)
  assert.equal((await fetch(service.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) })).status, 400)
  assert.equal((await fetch(service.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
  const { client } = await service.connect()
  const text = 'x'.repeat(5 * 1024 * 1024)
  assert.deepEqual((await client.callTool({ name: 'length', arguments: { text } })).content, [{ type: 'text', text: String(text.length) }])
  const oversized = await fetch(service.url, { method: 'POST', headers, body: 'x'.repeat(11 * 1024 * 1024 + 1) })
  assert.equal(oversized.status, 413)
  const streamed = await new Promise<number>((resolve, reject) => {
    const outgoing = request(service.url, { method: 'POST', headers }, incoming => { incoming.resume(); resolve(incoming.statusCode!) })
    outgoing.on('error', reject)
    outgoing.write('x'.repeat(11 * 1024 * 1024))
    outgoing.end('x')
  })
  assert.equal(streamed, 413)
  await client.ping()
})
