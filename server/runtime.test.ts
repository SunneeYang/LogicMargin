import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { createReviewServer } from './runtime.ts'
import { sampleReview } from '../src/sample.ts'

async function setup(t: { after(callback: () => Promise<void>): void }, large = false) {
  const dataDir = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-runtime-'))
  const html = '<!doctype html><title>LogicMargin</title><script src="/assets/app-abc.js"></script>'
  const javascript = 'console.log("packaged UI")'.repeat(large ? 1000 : 1)
  const service = await createReviewServer({ dataDir, instanceId: 'runtime-instance', version: '0.2.0', shutdownToken: 'only-owner-can-stop', assets: {
    '/index.html': { body: Buffer.from(html).toString('base64'), type: 'text/html; charset=utf-8' },
    '/assets/app-abc.js': { body: Buffer.from(javascript).toString('base64'), type: 'text/javascript; charset=utf-8' },
  } })
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }) })
  return { ...service, html, javascript }
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

test('embedded assets negotiate precompressed gzip, identity and matching HEAD headers', async t => {
  const service = await setup(t, true)
  const url = `${service.url}/assets/app-abc.js`
  const compressed = await raw(url, 'gzip')
  assert.equal(compressed.status, 200)
  assert.equal(compressed.headers['content-encoding'], 'gzip')
  assert.equal(compressed.headers['content-length'], String(compressed.body.length))
  assert.equal(gunzipSync(compressed.body).toString(), service.javascript)
  assert.equal(compressed.headers.vary, 'Accept-Encoding')
  assert.match(compressed.headers['cache-control']!, /immutable/)
  assert.equal(compressed.headers['x-content-type-options'], 'nosniff')
  for (const encoding of [undefined, 'identity', 'gzip;q=0', 'gzip;q=0.4, identity;q=1']) {
    const identity = await raw(url, encoding)
    assert.equal(identity.headers['content-encoding'], undefined)
    assert.equal(identity.body.toString(), service.javascript)
    assert.equal(identity.headers['content-length'], String(Buffer.byteLength(service.javascript)))
  }
  const head = await raw(url, 'gzip', 'HEAD')
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-encoding'], 'gzip')
  assert.equal(head.headers['content-length'], compressed.headers['content-length'])
  assert.equal(head.headers['cache-control'], compressed.headers['cache-control'])
  const unacceptable = await raw(url, 'gzip;q=0, identity;q=0')
  assert.equal(unacceptable.status, 406)
  assert.equal(unacceptable.body.length, 0)
  const health = await raw(`${service.url}/api/health`, undefined, 'HEAD')
  assert.equal(health.status, 200)
  assert.equal(health.body.length, 0)
  assert.ok(Number(health.headers['content-length']) > 0)
})

test('standalone runtime serves embedded UI, HEAD and SPA routes without exposing files or API fallbacks', async t => {
  const service = await setup(t)
  const index = await fetch(`${service.url}/`)
  assert.equal(index.status, 200)
  assert.equal(await index.text(), service.html)
  assert.match(index.headers.get('content-type')!, /text\/html/)
  assert.equal(index.headers.get('cache-control'), 'no-store')
  const javascript = await fetch(`${service.url}/assets/app-abc.js`)
  assert.equal(await javascript.text(), service.javascript)
  assert.match(javascript.headers.get('cache-control')!, /immutable/)
  const head = await fetch(`${service.url}/assets/app-abc.js`, { method: 'HEAD' })
  assert.equal(await head.text(), '')
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(service.javascript)))
  assert.equal(await (await fetch(`${service.url}/review/current`)).text(), service.html)
  for (const path of ['/package.json', '/assets/missing.js', '/api/no-such-endpoint']) {
    const missing = await fetch(`${service.url}${path}`)
    assert.equal(missing.status, 404)
    assert.match(missing.headers.get('content-type')!, /application\/json/)
  }
  const traversal = await new Promise<number>(resolve => {
    request(`${service.url}/%2e%2e%2fpackage.json`, response => { response.resume(); resolve(response.statusCode!) }).end()
  })
  assert.equal(traversal, 400)
  assert.equal((await fetch(`${service.url}/`, { method: 'POST' })).status, 405)
})

test('health identifies the service and session writes retain origin protection', async t => {
  const service = await setup(t)
  const response = await fetch(`${service.url}/api/health`)
  assert.deepEqual(await response.json(), { service: 'logic-margin', apiVersion: 1, version: '0.2.0', instanceId: 'runtime-instance', pid: process.pid, managed: true, mcp: true })
  const create = (origin: string) => fetch(`${service.url}/api/review-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ review: sampleReview }) })
  assert.equal((await create('https://different.example')).status, 403)
  const created = await create(service.url)
  assert.equal(created.status, 201)
  const session = await created.json()
  assert.equal((await (await fetch(`${service.url}/api/review-sessions/${session.id}`)).json()).review.id, sampleReview.id)
})

test('shutdown requires the owner token and closes an active review poll', async t => {
  const service = await setup(t)
  const url = `${service.url}/api/shutdown`
  assert.equal((await fetch(url)).status, 405)
  assert.equal((await fetch(url, { method: 'POST' })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-logic-margin-token': 'only-owner-can-stop', origin: 'https://different.example' } })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-logic-margin-token': 'only-owner-can-stop', 'sec-fetch-site': 'cross-site' } })).status, 403)
  const created = await fetch(`${service.url}/api/review-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ review: sampleReview }) })
  const session = await created.json()
  const poll = fetch(`${service.url}/api/review-sessions/${session.id}?afterVersion=1&waitMs=25000`).then(() => true, () => false)
  const stopped = await fetch(url, { method: 'POST', headers: { 'x-logic-margin-token': 'only-owner-can-stop', origin: service.url } })
  assert.equal(stopped.status, 200)
  assert.deepEqual(await stopped.json(), { stopped: true })
  await service.close()
  await poll
  await assert.rejects(fetch(`${service.url}/api/health`, { signal: AbortSignal.timeout(1000) }))
})
