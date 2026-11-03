import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { ensureService, getServiceStatus, runtimeVersion, stopService } from './daemon.ts'
import { processAlive } from './process-lock.ts'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'

const execute = promisify(execFile)

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-daemon-'))
  const home = join(directory, 'persistent home')
  const cwd = join(directory, 'independent project')
  await mkdir(cwd)
  const entry = join(directory, 'service entry.mts')
  const ownedPids = new Set<number>()
  const module = pathToFileURL(fileURLToPath(new URL('./daemon.ts', import.meta.url))).href
  await writeFile(entry, `import { ensureService, runDaemon, runtimeVersion } from ${JSON.stringify(module)}\n` +
    `const args = process.argv.slice(2); const values = new Map(); for(let i=1;i<args.length;i+=2)values.set(args[i],args[i+1]);\n` +
    `if(args[0]==='_serve')await runDaemon({assets:{'/index.html':{body:Buffer.from('<html>bundled</html>').toString('base64'),type:'text/html'}},home:values.get('--home'),host:values.get('--host'),port:Number(values.get('--port')),dataDir:values.get('--data-dir'),instanceId:values.get('--instance-id'),shutdownToken:values.get('--shutdown-token'),version:runtimeVersion});\n` +
    `else console.log(JSON.stringify(await ensureService({home:values.get('--home'),command:[process.execPath,process.argv[1]]})));\n`)
  t.after(async () => {
    await stopService({ home }).catch(() => {})
    for (const pid of ownedPids) if (pid !== process.pid && processAlive(pid)) process.kill(pid)
    await rm(directory, { recursive: true, force: true })
  })
  const start = async (env: Record<string, string> = {}) => {
    const result = await execute(process.execPath, [entry, '_ensure', '--home', home], { cwd, timeout: 15000, env: { ...process.env, ...env } })
    ownedPids.add((JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as { pid: number }).pid)
    return JSON.parse(result.stdout) as { url: string; managed: boolean }
  }
  const request = async (url: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`)
    return response.json()
  }
  return { directory, home, start, request }
}

test('explicit services never trigger startup or create managed state', async t => {
  const { home } = await setup(t)
  assert.deepEqual(await ensureService({ home, url: 'http://not-running.example:5173', command: ['not-an-executable'] }), { url: 'http://not-running.example:5173', managed: false })
  assert.deepEqual(await getServiceStatus({ home }), { running: false, managed: false })
  await assert.rejects(readFile(join(home, 'daemon.json')), { code: 'ENOENT' })
})

test('a custom data directory survives a restart without repeating the original environment', async t => {
  const { directory, home, start, request } = await setup(t)
  const dataDir = join(directory, 'existing reviews')
  const first = await start({ LOGIC_MARGIN_DATA_DIR: dataDir })
  const review = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], '旧数据目录中的意见必须保留')
  const created = await request(first.url, '/api/review-sessions', { review }) as { id: string }
  assert.equal(JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')).dataDir, dataDir)
  await stopService({ home })
  const restarted = await start()
  const restored = await request(restarted.url, `/api/review-sessions/${created.id}`) as { review: typeof review }
  assert.deepEqual(restored.review.comments, review.comments.map(comment => ({ ...comment, originRound: 1 })))
})

test('concurrent agent processes start one daemon, reuse it and recover opinions after stop', async t => {
  const { home, start, request } = await setup(t)
  const services = await Promise.all(Array.from({ length: 5 }, start))
  assert.ok(services.every(service => service.url === services[0].url && service.managed))
  const url = services[0].url
  const status = await getServiceStatus({ home })
  assert.equal(status.running, true)
  assert.equal(status.url, url)
  assert.equal(status.version, runtimeVersion)
  const review = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], '生命周期测试：重启后保留意见')
  const created = await request(url, '/api/review-sessions', { review }) as { id: string }
  const record = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as { pid: number }
  assert.equal(record.pid, status.pid)
  await assert.rejects(ensureService({ home, host: '0.0.0.0' }), /监听地址不同/)
  assert.equal(await stopService({ home }), true)
  assert.equal((await getServiceStatus({ home })).running, false)
  const restarted = await start()
  assert.equal(restarted.url, url)
  const restored = await request(restarted.url, `/api/review-sessions/${created.id}`) as { review: typeof review }
  assert.deepEqual(restored.review.comments, review.comments.map(comment => ({ ...comment, originRound: 1 })))
})

test('a crashed daemon and stale owner lock can be reclaimed concurrently without losing data', async t => {
  const { home, start, request } = await setup(t)
  const first = await start()
  const created = await request(first.url, '/api/review-sessions', { review: sampleReview }) as { id: string }
  const record = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as { pid: number }
  process.kill(record.pid, 'SIGKILL')
  const deadline = Date.now() + 3000
  while (processAlive(record.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(processAlive(record.pid), false)
  const recovered = await Promise.all(Array.from({ length: 4 }, start))
  assert.ok(recovered.every(service => service.url === recovered[0].url))
  const session = await request(recovered[0].url, `/api/review-sessions/${created.id}`) as { id: string }
  assert.equal(session.id, created.id)
})

test('corrupted registries and unrelated listeners are preserved instead of being overwritten or killed', async t => {
  const { home } = await setup(t)
  await mkdir(home, { recursive: true })
  const path = join(home, 'daemon.json')
  await writeFile(path, '{broken')
  await assert.rejects(ensureService({ home, command: ['not-an-executable'] }), /记录损坏/)
  assert.equal(await readFile(path, 'utf8'), '{broken')
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ service: 'another-service' })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  await writeFile(path, JSON.stringify({ pid: process.pid, url, host: '127.0.0.1', instanceId: 'unrelated', shutdownToken: 'secret', version: runtimeVersion, startedAt: new Date().toISOString() }))
  await assert.rejects(stopService({ home }), /身份或健康状态不匹配/)
  await assert.rejects(ensureService({ home, command: ['not-an-executable'] }), /进程仍在运行/)
  assert.equal((await fetch(url)).status, 200)
  await rm(path)
})

test('restarting on an occupied saved port fails without changing browser origin or killing the listener', async t => {
  const { home, start } = await setup(t)
  const first = await start()
  await stopService({ home })
  const original = await readFile(join(home, 'daemon.json'), 'utf8')
  const server = createServer((_request, response) => { response.end('other service') })
  await new Promise<void>(resolve => server.listen(Number(new URL(first.url).port), '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  await assert.rejects(start(), /后台服务提前退出/)
  assert.equal(await readFile(join(home, 'daemon.json'), 'utf8'), original)
  assert.equal(await (await fetch(first.url)).text(), 'other service')
})

test('a healthy daemon with a different program version is not silently reused', async t => {
  const { home } = await setup(t)
  await mkdir(home, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ service: 'logic-margin', apiVersion: 1, version: '0.0.0', instanceId: 'old-version', pid: process.pid, managed: true })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const path = join(home, 'daemon.json')
  await writeFile(path, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}`, host: '127.0.0.1', instanceId: 'old-version', shutdownToken: 'secret', version: '0.0.0', startedAt: new Date().toISOString() }))
  try { await assert.rejects(ensureService({ home, command: ['not-an-executable'] }), /先停止旧服务/) }
  finally { await rm(path) }
})
