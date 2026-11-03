import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { sendJson } from './http-response.ts'

const large = { message: '逻辑评审完整响应。'.repeat(2000) }

async function setup(t: TestContext) {
  let started!: () => void
  const abortStarted = new Promise<void>(resolve => { started = resolve })
  const server = createServer((incoming, response) => {
    response.setHeader('Vary', 'Origin')
    if (incoming.url === '/invalid') {
      const cycle: Record<string, unknown> = {}; cycle.self = cycle
      sendJson(incoming, response, 200, cycle)
    } else if (incoming.url === '/small') sendJson(incoming, response, 200, { ok: true })
    else {
      sendJson(incoming, response, 200, incoming.url === '/abort' ? { data: 'x'.repeat(4 * 1024 * 1024) } : large)
      if (incoming.headers['accept-encoding'] === 'gzip') assert.equal(response.headersSent, false, 'compression must be asynchronous')
      if (incoming.url === '/double') sendJson(incoming, response, 500, { error: 'must not replace the first response' })
      if (incoming.url === '/abort') started()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}`, abortStarted }
}

async function raw(url: string, encoding?: string, method = 'GET') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    request(url, { method, headers: encoding === undefined ? {} : { 'Accept-Encoding': encoding } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    }).on('error', reject).end()
  })
}

test('large JSON uses async gzip with complete bytes and negotiated HEAD headers', async t => {
  const { url } = await setup(t)
  const result = await raw(url, 'gzip')
  assert.equal(result.status, 200)
  assert.equal(result.headers['content-encoding'], 'gzip')
  assert.equal(result.headers['content-length'], String(result.body.length))
  assert.equal(result.headers.vary, 'Origin, Accept-Encoding')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(JSON.parse(gunzipSync(result.body).toString()), large)
  const head = await raw(url, 'gzip', 'HEAD')
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-encoding'], 'gzip')
  assert.equal(head.headers['content-length'], result.headers['content-length'])
})

test('encoding negotiation respects old clients, explicit identity, quality and wildcard exclusions', async t => {
  const { url } = await setup(t)
  for (const encoding of [undefined, '', 'identity', 'gzip;q=0', 'gzip ; q=0', 'gzip;q=0, *;q=1', 'gzip;q=0.5, identity;q=1', 'gzip;q=invalid']) {
    const result = await raw(url, encoding)
    assert.equal(result.headers['content-encoding'], undefined, String(encoding))
    assert.deepEqual(JSON.parse(result.body.toString()), large)
    assert.equal(result.headers['content-length'], String(result.body.length))
  }
  for (const encoding of ['GZIP', 'br, gzip;q=0.8', '*;q=0.5', 'gzip, identity;q=0']) {
    const result = await raw(url, encoding)
    assert.equal(result.headers['content-encoding'], 'gzip', encoding)
    assert.deepEqual(JSON.parse(gunzipSync(result.body).toString()), large)
  }
  for (const encoding of ['gzip;q=0, identity;q=0', '*;q=0']) {
    const result = await raw(url, encoding)
    assert.equal(result.status, 406)
    assert.equal(result.body.length, 0)
    assert.equal(result.headers['content-length'], '0')
  }
})

test('small JSON stays identity unless the client excludes identity', async t => {
  const { url } = await setup(t)
  const small = await raw(`${url}/small`, 'gzip')
  assert.equal(small.headers['content-encoding'], undefined)
  assert.deepEqual(JSON.parse(small.body.toString()), { ok: true })
  const required = await raw(`${url}/small`, 'gzip, identity;q=0')
  assert.equal(required.headers['content-encoding'], 'gzip')
  assert.deepEqual(JSON.parse(gunzipSync(required.body).toString()), { ok: true })
})

test('serialization failure is contained and a pending compressed response cannot be replaced', async t => {
  const { url } = await setup(t)
  const invalid = await raw(`${url}/invalid`)
  assert.equal(invalid.status, 500)
  assert.deepEqual(JSON.parse(invalid.body.toString()), { error: '响应序列化失败' })
  const result = await raw(`${url}/double`, 'gzip')
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(gunzipSync(result.body).toString()), large)
})

test('aborting while gzip runs does not write a second response or break subsequent requests', async t => {
  const { url, abortStarted } = await setup(t)
  const client = request(`${url}/abort`, { headers: { 'Accept-Encoding': 'gzip' } })
  client.on('error', () => {})
  client.end()
  await abortStarted
  client.destroy()
  const result = await raw(`${url}/small`)
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(result.body.toString()), { ok: true })
})
