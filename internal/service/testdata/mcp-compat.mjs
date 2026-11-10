import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const [root, url] = process.argv.slice(2)
const load = path => import(pathToFileURL(join(root, path)).href)
const { Client } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')
const { StreamableHTTPClientTransport } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')
const { sampleReview } = await load('src/sample.ts')
const { addComment } = await load('src/model.ts')

const client = new Client({ name: 'ts-compatibility-client', version: '1' })
const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
  reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
})
try {
  await client.connect(transport)
  const shape = tools => tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
    .sort((a, b) => a.name.localeCompare(b.name))
  assert.deepEqual(shape((await client.listTools()).tools), JSON.parse(await readFile(new URL('./mcp-catalog.json', import.meta.url), 'utf8')))

  const api = async (path, body) => {
    const response = await fetch(`${url}/api/review-sessions${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const value = await response.json()
    assert.ok(response.ok, JSON.stringify(value))
    return value
  }
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, JSON.stringify(result))
    return JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'))
  }
  const review = structuredClone(sampleReview)
  review.comments = []
  const created = await api('', { review })
  const path = `/${created.id}`
  const cancellation = new AbortController()
  const canceled = client.callTool({ name: 'wait_review', arguments: { session_id: created.id } }, undefined, { signal: cancellation.signal })
  await new Promise(resolve => setTimeout(resolve, 30))
  cancellation.abort(new Error('user cancelled'))
  await assert.rejects(canceled, /cancelled/)
  const timeout = await client.callTool({ name: 'wait_review', arguments: { session_id: created.id, timeout_seconds: 0.03 } })
  assert.equal(timeout.isError, true)
  assert.match(timeout.content[0].text, /超时/)

  let complete = false
  const waiting = call('wait_review', { session_id: created.id }).then(value => { complete = true; return value })
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '跨语言保留意见').comments.at(-1)
  const saved = await api(`${path}/mutations`, { revision: review.revision, fingerprint: review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }] })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(complete, false)
  const submitted = await api(`${path}/finish`, { expectedVersion: saved.version, kind: 'feedback' })
  const feedback = await waiting
  assert.equal(feedback.submission.id, submitted.history[0].id)
  assert.equal(feedback.requiresAcknowledgement, true)
  assert.equal((await call('get_review', { session_id: created.id })).phase, 'feedback-ready')
  await call('acknowledge_review', { session_id: created.id, submission_id: feedback.submission.id })

  const pending = client.callTool({ name: 'wait_review', arguments: { session_id: created.id } }, undefined, { timeout: 30000 })
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  await new Promise(resolve => setTimeout(resolve, 30))
  const stopped = await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'X-Logic-Margin-Token': 'only-owner-can-stop' } })
  assert.equal(stopped.status, 200)
  await stopped.text()
  let timer
  try {
    const result = await Promise.race([outcome, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('shutdown left TS SDK waiting')), 2000)
    })])
    assert.ok(result.error)
    assert.match(String(result.error), /正在停止/)
  } finally { clearTimeout(timer) }
  console.log('TS SDK -> Go: exact catalog/schema/annotations; cancel, timeout, feedback, acknowledgement and shutdown passed')
} finally {
  await client.close().catch(() => {})
}
