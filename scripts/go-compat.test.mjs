import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { createReviewServer } from '../server/runtime.ts'
import { SessionStore } from '../server/session-store.ts'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import { hostTarget, root } from './build-go.mjs'

const binary = process.env.LOGIC_MARGIN_GO_BINARY ?? join(root, 'artifacts/go', hostTarget, process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin')
const fixedDate = '2026-11-08T12:00:00.000Z'
const digest = value => createHash('sha256').update(value).digest('hex')

function graph() {
  const review = structuredClone(sampleReview)
  review.title = '中文 😀 & <源码> 与多轮审查'
  review.comments = []
  review.nodes.forEach(node => { node.evidence = [] })
  const code = 'const 名称 = "😀<&>";\nreturn 名称;'
  const files = [{ path: '😀<&>.ts', sha256: digest(code + '\r\n') }]
  review.snapshot = { ...review.snapshot, files, fingerprint: digest(JSON.stringify(files)), capturedAt: fixedDate }
  review.nodes[0].evidence = [{ path: files[0].path, symbol: '名称', startLine: 1, endLine: 2, digest: digest(code), code }]
  return review
}

function normalize(value, recordIds = new Map()) {
  const result = structuredClone(value)
  function document(review) {
    if (!review) return
    for (const comment of review.comments ?? []) for (const [index, reply] of (comment.replies ?? []).entries()) {
      if (!reply.id.startsWith('fixture-')) { reply.id = `@reply-${comment.id}-${index}`; reply.createdAt = '@time' }
    }
    if (review.baseline) document(review.baseline)
  }
  function record(record) {
    if (!record) return
    record.id = recordIds.get(record.id) ?? record.id
    record.createdAt = '@time'
    document(record.review)
  }
  function state(state) {
    state.id = '@session'
    state.createdAt = state.updatedAt = '@time'
    document(state.review)
    for (const [index,item] of (state.history ?? []).entries()) recordIds.set(item.id, `@record-${index}`)
    for (const item of state.history ?? []) record(item)
    for (const snapshot of state.snapshots ?? []) {
      snapshot.openedAt = '@time'
      if (snapshot.afterSubmission) snapshot.afterSubmission = recordIds.get(snapshot.afterSubmission)
      document(snapshot.review)
    }
    if (state.acknowledgedSubmission) state.acknowledgedSubmission = recordIds.get(state.acknowledgedSubmission)
  }
  if (result?.schemaVersion === 1 && result.phase) state(result)
  else if (result?.sessions) {
    for (const summary of result.sessions) { summary.id = '@session'; summary.createdAt = summary.updatedAt = '@time'; if (summary.archivedAt) summary.archivedAt = '@time' }
  } else if (result?.kind?.startsWith('logic-margin-')) record(result)
  else if (result?.openedAt) { result.openedAt = '@time'; document(result.review) }
  else if (result?.mode) { result.id = '@session'; if (result.archivedAt) result.archivedAt = '@time' }
  return result
}

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-go-compat-'))
  const nodeDir = join(directory, 'node'), goDir = join(directory, 'go')
  await mkdir(nodeDir); await mkdir(goDir)
  const node = await createReviewServer({ assets: { '/index.html': { body: Buffer.from('<html>test</html>').toString('base64'), type: 'text/html' } },
    dataDir: nodeDir, instanceId: 'node-test', shutdownToken: 'node-test', version: '0.8.7' })
  const child = spawn(binary, ['_serve', '--home', join(directory, 'home'), '--data-dir', goDir, '--host', '127.0.0.1', '--port', '0', '--instance-id', 'go-test', '--shutdown-token', 'go-test'],
    { cwd: directory, env: { ...process.env, PATH: join(directory, 'no-runtimes') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  let base
  try {
    const [line] = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(stderr || 'Go server exited') }), new Promise((_,reject) => { const timer = setTimeout(() => reject(new Error('Go server startup timeout')), 10000); timer.unref() })])
    base = JSON.parse(line).url
  } catch (error) { await node.close(); child.kill(); await rm(directory, { recursive: true, force: true }); throw error }
  t.after(async () => {
    await node.close()
    if (child.exitCode === null) {
      await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-logic-margin-token': 'go-test' } }).catch(() => {})
      const stop = setTimeout(() => child.kill(), 3000)
      try { await exited } finally { clearTimeout(stop) }
    }
    lines.close()
    await rm(directory, { recursive: true, force: true })
  })
  const request = async (url, path, body, headers = {}) => {
    const response = await fetch(`${url}/api/review-sessions${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: response.status, value: response.status === 204 ? null : await response.json() }
  }
  const ids = ['', ''], recordMaps = [new Map(), new Map()]
  const both = async (label, path, body, headers, status = 200) => {
    const results = await Promise.all([node.url, base].map((url,index) => request(url, typeof path === 'function' ? path(ids[index], index) : path, typeof body === 'function' ? body(index) : body, headers)))
    assert.equal(results[0].status, status, `${label} Node: ${JSON.stringify(results[0].value)}`)
    assert.equal(results[1].status, status, `${label} Go: ${JSON.stringify(results[1].value)}`)
    if (label === 'create') results.forEach((r,i) => { ids[i] = r.value.id })
    assert.deepEqual(normalize(results[1].value, recordMaps[1]), normalize(results[0].value, recordMaps[0]), label)
    return results.map(r => r.value)
  }
  return { directory, nodeDir, goDir, base, node, both, ids }
}

test('Go and Node preserve the same review lifecycle, projections, conflicts and archives', { timeout: 60000 }, async t => {
  const { both, ids, nodeDir, goDir } = await fixture(t)
  const review = graph()
  let states = await both('create', '', { review, scope: { context: 'compat-😀', purpose: '迁移对照 <&>' } }, undefined, 201)
  const path = id => `/${id}`
  await both('read', path)
  await both('current', id => `/${id}?view=current`)
  await both('timeout', id => `/${id}?afterVersion=1&waitMs=1`, undefined, undefined, 204)
  await both('origin', '', { review }, { origin: 'https://untrusted.invalid' }, 403)
  await both('content type', '', { review }, { 'content-type': 'text/plain' }, 415)
  await both('invalid identifier', '/not-a-session', undefined, undefined, 400)
  const comment = addComment(review, [{ kind: 'node', id: review.nodes[0].id }], '请核对 😀 的边界条件').comments.at(-1)
  comment.id = 'fixture-comment'; comment.createdAt = fixedDate
  const mutation = { round: 1, expectedVersion: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }] }
  states = await both('comment', id => `/${id}/mutations`, mutation)
  await both('idempotent comment', id => `/${id}/mutations`, mutation)
  states = await both('feedback', id => `/${id}/finish`, i => ({ expectedVersion: states[i].version, kind: 'feedback' }))
  const submissionIds = states.map(state => state.history.at(-1).id)
  await both('fixed record', (id,i) => `/${id}/records/${submissionIds[i]}`)
  await both('cannot approve open', id => `/${id}/finish`, i => ({ expectedVersion: states[i].version, kind: 'approval' }), undefined, 409)
  states = await both('acknowledge', id => `/${id}/ack`, i => ({ submissionId: submissionIds[i] }))
  await both('idempotent acknowledge', id => `/${id}/ack`, i => ({ submissionId: submissionIds[i] }))
  const next = structuredClone(review)
  next.revision += '-next'
  next.nodes[0].summary += ' 明确边界条件'
  const publication = { baseRound: 1, summary: '更新条件与最终回应', source: { algorithm: 'sha256-path-content-v1', checkedAt: fixedDate, fingerprint: next.snapshot.fingerprint, files: next.snapshot.files } }
  await both('atomic invalid replies', id => `/${id}/revise`, i => ({ expectedVersion: states[i].version, review: next, publication, replies: [{ commentId: 'unknown', body: 'reject' }] }), undefined, 400)
  states = await both('publish revision', id => `/${id}/revise`, i => ({ expectedVersion: states[i].version, review: next, publication, replies: [{ commentId: comment.id, body: '已完成，请复核 😀' }] }))
  await both('revision current', id => `/${id}?view=current`)
  await both('old snapshot', id => `/${id}/snapshots/1`)
  const resolution = i => ({ expectedVersion: states[i].version, round: 2, revision: next.revision, fingerprint: next.snapshot.fingerprint, mutations: [{ kind: 'set-status', commentId: comment.id, from: 'needs-review', status: 'resolved', reviewedRevision: next.revision }] })
  await both('wrong round', id => `/${id}/mutations`, i => ({ ...resolution(i), round: 1 }), undefined, 409)
  states = await both('resolve', id => `/${id}/mutations`, resolution)
  states = await both('approval', id => `/${id}/finish`, i => ({ expectedVersion: states[i].version, kind: 'approval' }))
  const versions = states.map(s => s.version)
  await both('archive', id => `/${id}/cleanup`, i => ({ expectedVersion: versions[i], mode: 'archive' }))
  await both('archived read', path, undefined, undefined, 410)
  await both('archive full', id => `/${id}/archive`)
  await both('archive list', '?state=all&context=compat-%F0%9F%98%80')
  // Read the Go gzip using the original Node implementation, without rewriting it.
  await cp(join(goDir, 'archive', `${ids[1]}.json.gz`), join(nodeDir, 'archive', `${ids[1]}.json.gz`))
  assert.equal((await new SessionStore(nodeDir).getArchive(ids[1])).review.comments[0].body, comment.body)
  states = await both('restore', id => `/${id}/restore`, i => ({ expectedVersion: versions[i] }))
  await both('delete', id => `/${id}/cleanup`, i => ({ expectedVersion: states[i].version, mode: 'delete' }))
  await both('deleted read', path, undefined, undefined, 404)
})

test('Go reads original Node active JSON and gzip archives without data conversion', { timeout: 30000 }, async t => {
  const { directory, nodeDir, goDir, base } = await fixture(t)
  const store = new SessionStore(nodeDir)
  const review = graph()
  const created = await store.create(review)
  await cp(join(nodeDir, `${created.id}.json`), join(goDir, `${created.id}.json`))
  const url = `${base}/api/review-sessions/${created.id}`
  const active = await (await fetch(url)).json()
  assert.deepEqual(active, created)
  const archived = await store.cleanup(created.id, { expectedVersion: created.version, mode: 'archive', allowUnfinished: true })
  await mkdir(join(goDir, 'archive'), { recursive: true })
  // Use a second ID for the archive test so the active copy remains immutable.
  const source = new SessionStore(join(directory, 'archive-source'))
  const second = await source.create(review)
  await source.cleanup(second.id, { expectedVersion: second.version, mode: 'archive', allowUnfinished: true })
  await cp(join(directory, 'archive-source', 'archive', `${second.id}.json.gz`), join(goDir, 'archive', `${second.id}.json.gz`))
  const response = await fetch(`${base}/api/review-sessions/${second.id}/archive`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), second)
  assert.ok(archived.archivedAt)
  assert.equal(JSON.parse(await readFile(join(goDir, `${created.id}.json`), 'utf8')).id, created.id)
})

test('concurrent native starts and crash recovery retain one writer, endpoint and custom data', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-go-recovery-'))
  const home = join(directory, 'home'), dataDir = join(directory, 'saved reviews')
  const env = { ...process.env, PATH: join(directory, 'no-runtimes'), LOGIC_MARGIN_HOME: home }
  delete env.LOGIC_MARGIN_URL; delete env.LOGIC_MARGIN_PUBLIC_URL; delete env.LOGIC_MARGIN_DATA_DIR
  const run = (args, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: directory, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}`)) }, 15000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `CLI exit ${code}`)) })
  })
  t.after(async () => { await run(['server', 'stop']).catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const starts = await Promise.all(Array.from({ length: 5 }, () => run(['server', 'start'], { LOGIC_MARGIN_DATA_DIR: dataDir })))
  assert.ok(starts.every(value => value.url === starts[0].url && value.managed))
  const base = starts[0].url
  const createdResponse = await fetch(`${base}/api/review-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ review: graph() }) })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  const raw = await readFile(join(dataDir, `${created.id}.json`))
  const before = await run(['server', 'status'])
  assert.equal(before.running, true)
  process.kill(before.pid, 'SIGKILL')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { process.kill(before.pid, 0) } catch { break }
    await delay(20)
  }
  assert.throws(() => process.kill(before.pid, 0))
  const recovered = await Promise.all(Array.from({ length: 5 }, () => run(['server', 'start'])))
  assert.ok(recovered.every(value => value.url === base))
  const after = await run(['server', 'status'])
  assert.notEqual(after.pid, before.pid)
  assert.equal(after.running, true)
  assert.equal((await run(['get', created.id])).id, created.id)
  assert.deepEqual(await readFile(join(dataDir, `${created.id}.json`)), raw)
  const registry = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8'))
  assert.equal(registry.dataDir, dataDir)
  const lockOwners = await import('node:fs/promises').then(fs => fs.readdir(join(dataDir, '.service-lock')))
  assert.equal(lockOwners.length, 1)
  assert.ok(lockOwners[0].startsWith(`${after.pid}.`))
})
