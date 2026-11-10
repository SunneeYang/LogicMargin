import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { createSessionApi } from '../server/api.ts'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const execute = promisify(execFile)
const goBackend = process.env.LOGIC_MARGIN_TEST_GO === '1'
const { packageAgent } = await import(goBackend ? './package-go-agent.mjs' : './package-agent.mjs')
const native = goBackend || process.env.LOGIC_MARGIN_TEST_NATIVE === '1'
let packageDirectory, packagedRoot, packagedCli, packagedCommand
const plugin = new URL('../plugins/logic-margin/', import.meta.url)
const version = JSON.parse(await readFile(new URL('plugin.json', plugin), 'utf8')).version

const sourceText = '演示套餐升级保留原有集成与通知设置。\n失败时保留原套餐、集成与通知设置。\n'
const sha256 = value => createHash('sha256').update(value).digest('hex')

async function sourceReview(cwd, content = sourceText, previous = sampleReview) {
  const review = structuredClone(previous)
  review.comments = []
  review.nodes.forEach(node => { node.evidence = [] })
  const files = [{ path: 'logic.md', sha256: sha256(content) }]
  const snippet = content.replaceAll('\r\n', '\n').replace(/\n$/, '')
  review.nodes[0].evidence = [{ path: 'logic.md', symbol: '评审规则', startLine: 1, endLine: snippet.split('\n').length, digest: sha256(snippet) }]
  review.snapshot = { ...review.snapshot, repository: cwd, commit: 'package-test-fixture', dirty: true, files, fingerprint: sha256(JSON.stringify(files)) }
  await writeFile(join(cwd, 'logic.md'), content)
  return review
}

before(async () => {
  packageDirectory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-native-package-'))
  const directory = packageDirectory
  const target = native ? `${process.platform}-${process.arch}` : undefined
  const archive = await packageAgent(directory, target)
  const unpacked = join(directory, 'unpacked')
  await mkdir(unpacked)
  await execute('unzip', ['-q', archive, '-d', unpacked])
  packagedRoot = join(unpacked, `logic-margin-agent-${version}${target ? `-${target}` : ''}`)
  assert.deepEqual(await readFile(join(packagedRoot, 'LICENSE')), await readFile(new URL('../LICENSE', import.meta.url)), 'Every distribution must carry the project license')
  assert.deepEqual(await readFile(join(packagedRoot, 'plugins/logic-margin/LICENSE')), await readFile(new URL('../LICENSE', import.meta.url)), 'The independently installed plugin must carry the project license')
  const executable = native ? process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin' : 'logic-margin.mjs'
  packagedCli = join(packagedRoot, 'plugins/logic-margin/skills/logic-margin/scripts', executable)
  packagedCommand = native ? [packagedCli] : [process.execPath, packagedCli]
  const entries = goBackend ? [executable, 'logic-margin.ps1', 'logic-margin.sh'] : [executable]
  assert.deepEqual((await readdir(join(packagedRoot, 'plugins/logic-margin/skills/logic-margin/scripts'))).sort(), entries.sort(), 'Distribution must contain only its selected runtime and native launchers, excluding stale entries, public assets and real review data')
  if (goBackend) {
    assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${sha256(await readFile(archive))}  ${archive.split(/[\\/]/).at(-1)}\n`)
    const runtimeVersion = await execute(packagedCli, ['--version'])
    assert.equal(runtimeVersion.stdout.trim(), version, 'Native runner must match the plugin version used for downloads and cache keys')
    for (const path of ['plugin.json', 'skills/logic-margin/SKILL.md', 'skills/logic-margin/scripts/logic-margin.sh', 'skills/logic-margin/scripts/logic-margin.ps1',
      ...(await readdir(new URL('skills/logic-margin/references/', plugin))).map(name => `skills/logic-margin/references/${name}`)]) {
      assert.deepEqual(await readFile(join(packagedRoot, 'plugins/logic-margin', path)), await readFile(new URL(path, plugin)), `${path} must be shipped unchanged`)
    }
    const notices = await readFile(join(packagedRoot, 'plugins/logic-margin/THIRD_PARTY_NOTICES.md'), 'utf8')
    assert.ok(notices.startsWith(await readFile(new URL('THIRD_PARTY_NOTICES.md', plugin), 'utf8')))
    for (const dependency of ['@lezer/common', '@lezer/javascript', '@lezer/lr', '@lezer/highlight', 'github.com/dop251/goja', 'github.com/modelcontextprotocol/go-sdk', 'Go standard library and runtime']) {
      assert.ok(notices.includes(dependency), `Missing license notice for ${dependency}`)
    }
  }
}, { timeout: 240000 })

after(async () => { if (packageDirectory) await rm(packageDirectory, { recursive: true, force: true }) })

test('native launchers use the sibling or versioned cache and reject a mismatched runner', { skip: !goBackend }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-launcher-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pluginRoot = join(directory, 'marketplace plugin with spaces')
  await cp(join(packagedRoot, 'plugins/logic-margin'), pluginRoot, { recursive: true })
  const windows = process.platform === 'win32'
  const scripts = join(pluginRoot, 'skills/logic-margin/scripts')
  const executable = windows ? 'logic-margin.exe' : 'logic-margin'
  const launcher = join(scripts, windows ? 'logic-margin.ps1' : 'logic-margin.sh')
  const command = windows ? 'powershell.exe' : '/bin/sh'
  const args = windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '--version'] : [launcher, '--version']
  const cacheRoot = join(directory, 'cache with spaces')
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot, LOCALAPPDATA: cacheRoot }
  const run = () => execute(command, args, { cwd: directory, env, timeout: 10000 })
  assert.equal((await run()).stdout.trim(), version)
  await rm(join(scripts, executable))
  const cacheBinary = cachedVersion => join(cacheRoot, 'logic-margin/native', cachedVersion, `${process.platform}-${process.arch}`, executable)
  await mkdir(dirname(cacheBinary(version)), { recursive: true })
  await cp(packagedCli, cacheBinary(version))
  assert.equal((await run()).stdout.trim(), version)
  const otherVersion = '0.0.0'
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'))
  await writeFile(join(pluginRoot, 'plugin.json'), JSON.stringify({ ...manifest, version: otherVersion }))
  await mkdir(dirname(cacheBinary(otherVersion)), { recursive: true })
  await cp(packagedCli, cacheBinary(otherVersion))
  await assert.rejects(run(), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /does not match plugin/)
    return true
  })
})

async function setup(t) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-agent-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = packagedRoot, cli = packagedCli
  const cwd = join(directory, 'another project with spaces')
  await mkdir(cwd)
  const seenPolls = new Set()
  const events = new EventEmitter()
  const api = createSessionApi({ dataDir: join(directory, 'sessions') })
  const server = createServer((request, response) => {
    const query = new URL(request.url, 'http://localhost').searchParams
    if (query.has('afterVersion')) {
      seenPolls.add(Number(query.get('afterVersion')))
      events.emit('poll')
    }
    api(request, response, () => { response.writeHead(404); response.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const call = async (path, body) => {
    const response = await fetch(`${base}/api/review-sessions${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await response.json()
    assert.ok(response.ok, JSON.stringify(result))
    return result
  }
  const run = (args, env = {}) => {
    const child = spawn(packagedCommand[0], [...packagedCommand.slice(1), ...args], {
      cwd,
      env: { ...process.env, PATH: join(directory, 'no-runtimes-on-path'), LOGIC_MARGIN_URL: base, LOGIC_MARGIN_PUBLIC_URL: 'http://100.64.0.9:5173', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const result = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout, stderr }))
    })
    t.after(() => { if (child.exitCode === null) child.kill() })
    return { child, result, get stdout() { return stdout } }
  }
  const poll = async version => {
    const signal = AbortSignal.timeout(3000)
    while (!seenPolls.has(version)) await once(events, 'poll', { signal })
  }
  return { root, cli, cwd, base, call, run, poll }
}

test('distributed CLI runs outside the repo and completes wait, reply, revision and recovery', async t => {
  const { cwd, call, run, poll } = await setup(t)
  const review = await sourceReview(cwd)
  await writeFile(join(cwd, 'review.json'), JSON.stringify(review))
  const started = await run(['start', 'review.json']).result
  assert.equal(started.code, 0, started.stderr)
  const identity = JSON.parse(started.stdout)
  assert.equal(identity.url, `http://100.64.0.9:5173/?session=${identity.sessionId}`)
  const path = `/${identity.sessionId}`
  const waiting = run(['wait', identity.sessionId, '--timeout', '10'])
  await poll(1)
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '包级测试：核对失败时状态保留。').comments.at(-1)
  const saved = await call(`${path}/mutations`, {
    revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }],
  })
  await poll(saved.version)
  assert.equal(waiting.child.exitCode, null)
  assert.equal(waiting.stdout, '')
  const submitted = await call(`${path}/finish`, { expectedVersion: saved.version, kind: 'feedback' })
  const received = await waiting.result
  assert.equal(received.code, 0, received.stderr)
  const feedback = JSON.parse(received.stdout)
  assert.equal(feedback.approved, false)
  assert.equal(feedback.submission.id, submitted.history[0].id)
  assert.equal(feedback.submission.review.comments[0].body, comment.body)
  assert.equal((await call(path)).phase, 'agent-working')

  await writeFile(join(cwd, 'reply.txt'), '包级测试回应：已补充失败出口。\n请复核新版规则。')
  const replied = await run(['reply', identity.sessionId, comment.id, '--body-file', 'reply.txt']).result
  assert.equal(replied.code, 0, replied.stderr)
  const next = await sourceReview(cwd, `${sourceText}失败时不扣升级费用。\n`, review)
  next.revision = 'package-test-v2'
  next.nodes[0].detail += ' 包级测试补充规则。'
  await writeFile(join(cwd, 'next.json'), JSON.stringify(next))
  const finalReply = '新版流程与依据已更新。\n请复核失败时不扣费。'
  await writeFile(join(cwd, 'final-replies.json'), JSON.stringify([{ commentId: comment.id, body: finalReply }]))
  const revised = await run(['revise', identity.sessionId, 'next.json', '--base-round', '1', '--summary', '补充失败时不扣升级费用的规则',
    '--replies-file', 'final-replies.json']).result
  assert.equal(revised.code, 0, revised.stderr)
  assert.equal(JSON.parse(revised.stdout).round, 2)
  const resumed = await run(['resume', identity.sessionId]).result
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).sessionId, identity.sessionId)
  const fetched = await run(['get', identity.sessionId]).result
  assert.equal(fetched.code, 0, fetched.stderr)
  const restored = JSON.parse(fetched.stdout)
  assert.equal(restored.review.nodes[0].evidence[0].code, `${sourceText}失败时不扣升级费用。`)
  assert.equal(restored.review.comments[0].status, 'needs-review')
  assert.equal(restored.review.comments[0].revision, review.revision)
  assert.equal(restored.review.comments[0].replies[0].body, '包级测试回应：已补充失败出口。\n请复核新版规则。')
  assert.equal(restored.review.comments[0].replies[1].body, finalReply)
  assert.equal(restored.review.comments[0].replies[1].revision, next.revision)
  assert.equal(restored.review.comments[0].replies[1].round, 2)
  assert.equal(restored.snapshots[1].publication.baseRound, 1)
  assert.deepEqual(restored.snapshots[1].publication.source.files, next.snapshot.files)
  assert.equal(restored.history.length, 1)
})

test('distributed verify checks real source files offline and rejects stale provenance', async t => {
  const { cwd, run } = await setup(t)
  const review = await sourceReview(cwd)
  await writeFile(join(cwd, 'review.json'), JSON.stringify(review))
  const env = { LOGIC_MARGIN_URL: 'http://127.0.0.1:1' }
  const verified = await run(['verify', 'review.json'], env).result
  assert.equal(verified.code, 0, verified.stderr)
  const source = JSON.parse(verified.stdout)
  assert.equal(source.algorithm, 'sha256-path-content-v1')
  assert.equal(source.fingerprint, review.snapshot.fingerprint)
  assert.deepEqual(source.files, review.snapshot.files)
  await writeFile(join(cwd, 'logic.md'), `${sourceText}已修改但尚未重画流程。\n`)
  const stale = await run(['verify', 'review.json'], env).result
  assert.equal(stale.code, 1)
  assert.match(stale.stderr, /来源文件已变化/)
  assert.equal(stale.stdout, '')
})

test('packaged CLI honors explicit endpoint overrides and rejects malformed input', async t => {
  await assert.rejects(packageAgent(packageDirectory, 'unsupported-target'), /不支持目标/)
  const { cwd, base, call, run } = await setup(t)
  const help = await run(['--help']).result
  assert.equal(help.code, 0, help.stderr)
  const review = await sourceReview(cwd)
  await writeFile(join(cwd, 'valid.json'), JSON.stringify(review))
  const started = await run(['start', 'valid.json', '--url', base, '--public-url', 'http://100.64.0.10:5173'], {
    LOGIC_MARGIN_URL: 'http://127.0.0.1:1', LOGIC_MARGIN_PUBLIC_URL: 'http://100.64.0.11:5173',
  }).result
  assert.equal(started.code, 0, started.stderr)
  const identity = JSON.parse(started.stdout)
  assert.equal(identity.url, `http://100.64.0.10:5173/?session=${identity.sessionId}`)
  await writeFile(join(cwd, 'invalid.json'), '{not-json')
  const invalid = await run(['start', 'invalid.json']).result
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, /LogicMargin:/)
  assert.equal(invalid.stdout, '')
  assert.equal((await call(`/${identity.sessionId}`)).review.comments.length, 0)
})

test('complete package auto-starts embedded UI and restores opinions after a service restart', async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-native-cold-start-'))
  const cwd = join(directory, 'source project with spaces')
  await mkdir(cwd)
  const env = { ...process.env, PATH: join(directory, 'no-runtimes-on-path'), LOGIC_MARGIN_HOME: join(directory, 'service-home') }
  delete env.LOGIC_MARGIN_URL
  delete env.LOGIC_MARGIN_PUBLIC_URL
  delete env.LOGIC_MARGIN_DATA_DIR
  const run = async args => {
    try { return { code: 0, ...(await execute(packagedCommand[0], [...packagedCommand.slice(1), ...args], { cwd, env })) } }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
  }
  t.after(async () => {
    await run(['server', 'stop'])
    await rm(directory, { recursive: true, force: true })
  })
  const review = await sourceReview(cwd)
  await writeFile(join(cwd, 'review.json'), JSON.stringify(review))
  const started = await run(['start', 'review.json'])
  assert.equal(started.code, 0, started.stderr)
  const identity = JSON.parse(started.stdout)
  const statusResult = await run(['server', 'status'])
  assert.equal(statusResult.code, 0, statusResult.stderr)
  const status = JSON.parse(statusResult.stdout)
  assert.equal(status.running, true)
  assert.equal(status.managed, true)
  const health = await (await fetch(`${status.url}/api/health`)).json()
  assert.equal(health.service, 'logic-margin')
  assert.equal(health.managed, true)
  if (goBackend) assert.equal(health.version, version)
  const page = await fetch(`${status.url}/`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /<div id="root"><\/div>/)
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
  assert.ok(script)
  const asset = await fetch(new URL(script, status.url))
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /javascript/)
  const codeChunk = (await asset.text()).match(/CodeDiffEditor-[\w-]+\.js/)?.[0]
  assert.ok(codeChunk, 'The code comparison tool must remain a lazy local asset')
  const codeAsset = await fetch(new URL(codeChunk, new URL(script, status.url)))
  assert.equal(codeAsset.status, 200, 'The standalone package must serve the code comparison chunk offline')
  assert.match(await codeAsset.text(), /cm-mergeView/)
  assert.equal((await fetch(`${status.url}/reviews/task-pipeline.logic-margin.json`)).status, 404)
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '原生包重启后仍保留的意见。').comments.at(-1)
  const saved = await fetch(`${status.url}/api/review-sessions/${identity.sessionId}/mutations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      revision: review.revision, fingerprint: review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }],
    }),
  })
  assert.equal(saved.status, 200)
  const reused = await run(['get', identity.sessionId])
  assert.equal(reused.code, 0, reused.stderr)
  const healthAgain = await (await fetch(`${status.url}/api/health`)).json()
  assert.equal(healthAgain.instanceId, health.instanceId)
  const stopped = await run(['server', 'stop'])
  assert.equal(stopped.code, 0, stopped.stderr)
  const resumed = await run(['resume', identity.sessionId])
  assert.equal(resumed.code, 0, resumed.stderr)
  const restored = await run(['get', identity.sessionId])
  assert.equal(restored.code, 0, restored.stderr)
  assert.equal(JSON.parse(restored.stdout).review.comments[0].body, comment.body)
  const newStatus = JSON.parse((await run(['server', 'status'])).stdout)
  const newHealth = await (await fetch(`${newStatus.url}/api/health`)).json()
  assert.notEqual(newHealth.instanceId, health.instanceId)
})

test('distributed CLI isolates purposes and archives, restores and deletes only the selected review', async t => {
  const { cwd, call, run } = await setup(t)
  const review = await sourceReview(cwd)
  await writeFile(join(cwd, 'review.json'), JSON.stringify(review))
  const first = await run(['start', 'review.json', '--context', 'package-context', '--purpose', '票券扣除', '--cleanup-on-approval']).result
  assert.equal(first.code, 0, first.stderr)
  const id = JSON.parse(first.stdout).sessionId
  const second = await run(['start', 'review.json', '--context', 'package-context', '--purpose', '异常回滚']).result
  assert.equal(second.code, 0, second.stderr)
  const sibling = JSON.parse(second.stdout).sessionId
  const current = await call(`/${id}`)
  assert.equal(current.cleanupPolicy, 'archive-on-approval')
  assert.equal(current.scope.purpose, '票券扣除')
  await call(`/${id}/finish`, { expectedVersion: current.version, kind: 'approval' })
  const received = await run(['wait', id, '--timeout', '3']).result
  assert.equal(received.code, 0, received.stderr)
  assert.equal(JSON.parse(received.stdout).approved, true)
  const list = await run(['list', '--context', 'package-context', '--state', 'all']).result
  assert.equal(list.code, 0, list.stderr)
  const tasks = JSON.parse(list.stdout).sessions
  assert.equal(tasks.length, 2)
  assert.ok(tasks.find(item => item.id === id).archivedAt)
  assert.equal(tasks.find(item => item.id === sibling).archivedAt, undefined)
  const restored = await run(['restore', id]).result
  assert.equal(restored.code, 0, restored.stderr)
  const archived = await run(['cleanup', id]).result
  assert.equal(archived.code, 0, archived.stderr)
  assert.equal(JSON.parse(archived.stdout).mode, 'archive')
  const deleted = await run(['cleanup', id, '--mode', 'delete']).result
  assert.equal(deleted.code, 0, deleted.stderr)
  assert.equal(JSON.parse(deleted.stdout).mode, 'delete')
  const after = JSON.parse((await run(['list', '--context', 'package-context', '--state', 'all']).result).stdout)
  assert.deepEqual(after.sessions.map(item => item.id), [sibling])
  assert.equal((await call(`/${sibling}`)).review.comments.length, 0)
})

test('one packaged daemon serves UI, API and multiple MCP clients and restores a disconnected wait', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-mcp-package-'))
  const home = join(directory, 'service home')
  const cwd = join(directory, 'review project')
  await mkdir(cwd)
  const clients = []
  const env = { ...process.env, LOGIC_MARGIN_HOME: home }
  delete env.LOGIC_MARGIN_URL
  delete env.LOGIC_MARGIN_PUBLIC_URL
  const run = args => execute(packagedCommand[0], [...packagedCommand.slice(1), ...args], {
    cwd, env, timeout: 15000,
  })
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await run(['server', 'stop']).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  const connect = async url => {
    const client = new Client({ name: 'packaged-review-test', version: '1.0.0' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
  }
  const tool = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return JSON.parse(result.content.find(item => item.type === 'text').text)
  }
  const first = JSON.parse((await run(['server', 'start'])).stdout)
  assert.equal(first.mcpUrl, `${first.url}/mcp`)
  const health = await (await fetch(`${first.url}/api/health`)).json()
  const client = await connect(first.mcpUrl)
  const sibling = await connect(first.mcpUrl)
  assert.equal((await client.listTools()).tools.length, 11)
  const review = await sourceReview(cwd)
  const reviewFile = join(cwd, 'review.json')
  await writeFile(reviewFile, JSON.stringify(review))
  const created = await tool(client, 'start_review', { review_file: reviewFile, source_root: cwd, purpose: '打包后 MCP 恢复' })
  const found = await tool(sibling, 'get_review', { session_id: created.sessionId })
  assert.equal(found.id, created.sessionId)
  assert.equal(found.review.nodes[0].evidence[0].code, sourceText.replace(/\n$/, ''))
  assert.equal((await (await fetch(`${first.url}/api/health`)).json()).pid, health.pid)
  assert.equal((await fetch(first.url)).status, 200)
  let returned = false
  const waiting = tool(client, 'wait_review', { session_id: created.sessionId }).finally(() => { returned = true })
  const comment = addComment(review, [{ kind: 'review', id: review.id }], '同一个后台承载网页和 MCP。').comments.at(-1)
  const save = async (base, body) => {
    const response = await fetch(`${base}/api/review-sessions/${created.sessionId}/mutations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const submit = async (base, version) => {
    const response = await fetch(`${base}/api/review-sessions/${created.sessionId}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, kind: 'feedback' }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const saved = await save(first.url, { revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }] })
  await tool(sibling, 'get_review', { session_id: created.sessionId })
  assert.equal(returned, false, 'Saving a comment must not complete the MCP wait')
  await submit(first.url, saved.version)
  const feedback = await waiting
  assert.equal(feedback.requiresAcknowledgement, true)
  assert.equal((await tool(sibling, 'get_review', { session_id: created.sessionId })).phase, 'feedback-ready')
  await tool(client, 'acknowledge_review', { session_id: created.sessionId, submission_id: feedback.submission.id })

  const interrupted = client.callTool({ name: 'wait_review', arguments: { session_id: created.sessionId, after_submission: feedback.submission.id } },
    undefined, { timeout: 5000 }).then(result => ({ result }), error => ({ error }))
  await tool(sibling, 'get_review', { session_id: created.sessionId })
  await run(['server', 'stop'])
  const stopped = await interrupted
  assert.ok(stopped.error || stopped.result?.isError, 'Stopping the daemon must fail a pending MCP wait')
  const status = JSON.parse((await run(['server', 'status'])).stdout)
  assert.equal(status.running, false)
  assert.equal(status.processRunning, false)
  const restarted = JSON.parse((await run(['server', 'start'])).stdout)
  assert.equal(restarted.url, first.url)
  const recovered = await connect(restarted.mcpUrl)
  assert.equal((await tool(recovered, 'get_review', { session_id: created.sessionId })).history[0].id, feedback.submission.id)
  const pending = tool(recovered, 'wait_review', { session_id: created.sessionId, after_submission: feedback.submission.id })
  const nextComment = addComment(review, [{ kind: 'review', id: review.id }], '重连后读取新的提交。').comments.at(-1)
  const next = await save(restarted.url, { revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment: nextComment }] })
  await submit(restarted.url, next.version)
  const nextFeedback = await pending
  assert.notEqual(nextFeedback.submission.id, feedback.submission.id)
  assert.equal(nextFeedback.submission.review.comments[0].id, nextComment.id)
})
