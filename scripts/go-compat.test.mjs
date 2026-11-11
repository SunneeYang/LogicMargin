import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { startGo } from './go-process.mjs'
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

test('native HTTP replays the frozen legacy lifecycle contract including exact errors', async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-http-oracle-'))
  const service = await startGo({ binary, dataDir: directory })
  t.after(async () => { try { await service.stop() } finally { await rm(directory, { recursive: true, force: true }) } })
  const oracle = JSON.parse(await readFile(new URL('../internal/review/testdata/oracle.json', import.meta.url), 'utf8'))
  let id
  for (const step of oracle.steps) {
    const { op, input, view } = step
    let path = `/${id}`, body
    if (op === 'create') { path = ''; body = { review: input.review, ...input.options } }
    else if (op === 'getSnapshot') path += `/snapshots/${input.round}`
    else if (op === 'getRecord') path += `/records/${input.record}`
    else if (op === 'getArchive') path += '/archive'
    else if (op !== 'get') { path += `/${({ mutate: 'mutations', acknowledge: 'ack' })[op] ?? op}`; body = input }
    if (view) path += `?view=${view}`
    const response = await fetch(`${service.url}/api/review-sessions${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const value = await response.json()
    assert.equal(response.status, step.status ?? (op === 'create' ? 201 : 200), op)
    if (step.error) { assert.equal(value.error, step.error, op); continue }
    if (op === 'create') id = value.id
    if (value.view === 'current') {
      // The frozen lifecycle predates edit permissions; its submitted discussions stay read-only.
      assert.deepEqual(value.editableDiscussion, { comments: [], replies: [] }, `${op}: frozen discussion permissions`)
      delete value.editableDiscussion
    }
    if (value.schemaVersion === 1 && value.phase) {
      value.id = '<session>'; value.createdAt = '<created>'; value.updatedAt = '<updated>'
      for (const record of value.history ?? []) record.createdAt = '<record>'
      for (const snapshot of value.snapshots ?? []) snapshot.openedAt = '<opened>'
    }
    if (value.openedAt && value.review) value.openedAt = '<opened>'
    if (['logic-margin-feedback', 'logic-margin-approval'].includes(value.kind)) value.createdAt = '<record>'
    if (value.archivedAt) value.archivedAt = '<archive>'
    if (value.id === id) value.id = '<session>'
    assert.deepEqual(value, step.output, op)
  }
})

test('native HTTP reads the frozen legacy active JSON and gzip without conversion', async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-fixed-contract-'))
  const services = []
  t.after(async () => {
    const stopped = await Promise.allSettled(services.map(service => service.stop()))
    await rm(directory, { recursive: true, force: true })
    for (const result of stopped) if (result.status === 'rejected') throw result.reason
  })
  const dataDir = join(directory, 'sessions')
  await mkdir(join(dataDir, 'archive'), { recursive: true })
  const archive = await readFile(new URL('../internal/review/testdata/legacy-session.json.gz', import.meta.url))
  const legacy = JSON.parse(gunzipSync(archive)).session
  const raw = Buffer.from(JSON.stringify(legacy))
  await writeFile(join(dataDir, `${legacy.id}.json`), raw)
  const service = await startGo({ binary, dataDir })
  services.push(service)
  let response = await fetch(`${service.url}/api/review-sessions/${legacy.id}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), legacy)
  assert.deepEqual(await readFile(join(dataDir, `${legacy.id}.json`)), raw)
  await service.stop()
  await rm(join(dataDir, `${legacy.id}.json`))
  await writeFile(join(dataDir, 'archive', `${legacy.id}.json.gz`), archive)
  const restarted = await startGo({ binary, dataDir })
  services.push(restarted)
  response = await fetch(`${restarted.url}/api/review-sessions/${legacy.id}/archive`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), legacy)
  assert.deepEqual(await readFile(join(dataDir, 'archive', `${legacy.id}.json.gz`)), archive)
  const invalid = await fetch(`${restarted.url}/api/review-sessions/not-a-session`)
  assert.equal(invalid.status, 400)
  assert.equal((await fetch(`${restarted.url}/api/review-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' }, body: JSON.stringify({ review: graph() }) })).status, 403)
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
