import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { packageAgent } from './package-agent.mjs'
import { createSessionApi } from '../server/api.ts'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'

const execute = promisify(execFile)
const native = process.env.LOGIC_MARGIN_TEST_NATIVE === '1'
let packageDirectory, packagedRoot, packagedCli, packagedCommand

before(async () => {
  packageDirectory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-native-package-'))
  const directory = packageDirectory
  const target = native ? `${process.platform}-${process.arch}` : undefined
  const archive = await packageAgent(directory, target)
  const unpacked = join(directory, 'unpacked')
  await mkdir(unpacked)
  await execute('unzip', ['-q', archive, '-d', unpacked])
  const version = JSON.parse(await readFile(new URL('../plugins/logic-margin/plugin.json', import.meta.url), 'utf8')).version
  packagedRoot = join(unpacked, `logic-margin-agent-${version}${target ? `-${target}` : ''}`)
  const executable = native ? process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin' : 'logic-margin.mjs'
  packagedCli = join(packagedRoot, 'plugins/logic-margin/skills/logic-margin/scripts', executable)
  packagedCommand = native ? [packagedCli] : [process.execPath, packagedCli]
  assert.deepEqual(await readdir(join(packagedRoot, 'plugins/logic-margin/skills/logic-margin/scripts')), [executable], 'Distribution must contain only its selected runtime, excluding stale entries, public assets and real review data')
}, { timeout: 120000 })

after(async () => { if (packageDirectory) await rm(packageDirectory, { recursive: true, force: true }) })

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
  const review = structuredClone(sampleReview)
  review.comments = []
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
  const next = structuredClone(review)
  next.revision = 'package-test-v2'
  next.snapshot.fingerprint = 'package-test-source-v2'
  next.nodes[0].detail += ' 包级测试补充规则。'
  await writeFile(join(cwd, 'next.json'), JSON.stringify(next))
  const revised = await run(['revise', identity.sessionId, 'next.json']).result
  assert.equal(revised.code, 0, revised.stderr)
  assert.equal(JSON.parse(revised.stdout).round, 2)
  const resumed = await run(['resume', identity.sessionId]).result
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).sessionId, identity.sessionId)
  const fetched = await run(['get', identity.sessionId]).result
  assert.equal(fetched.code, 0, fetched.stderr)
  const restored = JSON.parse(fetched.stdout)
  assert.equal(restored.review.comments[0].status, 'needs-review')
  assert.equal(restored.review.comments[0].revision, review.revision)
  assert.equal(restored.review.comments[0].replies[0].body, '包级测试回应：已补充失败出口。\n请复核新版规则。')
  assert.equal(restored.history.length, 1)
})

test('packaged CLI honors explicit endpoint overrides and rejects malformed input', async t => {
  await assert.rejects(packageAgent(packageDirectory, 'unsupported-target'), /不支持目标/)
  const { cwd, base, call, run } = await setup(t)
  const help = await run(['--help']).result
  assert.equal(help.code, 0, help.stderr)
  const review = structuredClone(sampleReview)
  review.comments = []
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
  const review = structuredClone(sampleReview)
  review.comments = []
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
  const page = await fetch(`${status.url}/`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /<div id="root"><\/div>/)
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
  assert.ok(script)
  const asset = await fetch(new URL(script, status.url))
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /javascript/)
  assert.equal((await fetch(`${status.url}/reviews/spirit-sanctum.logic-margin.json`)).status, 404)
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
