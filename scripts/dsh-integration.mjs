import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archive = resolve(process.argv[2] ?? join(root, 'artifacts/dsh-plugin-logicmargin-0.9.6.tgz'))
const output = resolve(process.argv[3] ?? join(root, '.scratch/dsh-integration.json'))
const dshRoot = process.env.LOGIC_MARGIN_DSH_ROOT
assert.ok(dshRoot && isAbsolute(dshRoot), 'Set LOGIC_MARGIN_DSH_ROOT to an installed @deepseek-ai/dsh package directory')
assert.ok(process.env.CODEX_AGENT_TMP && isAbsolute(process.env.CODEX_AGENT_TMP), 'Run with agent-tmp-run; temporary profile and native data must be disposable')
await access(archive)
const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP, 'logic-margin-dsh-integration-'))
const home = join(directory, 'home'), dshHome = join(home, '.dsh')
const nativeHome = join(home, '.logic-margin'), dataDir = join(nativeHome, 'sessions')
const profileName = 'logic-margin-isolated-test'
const inherited = { ...process.env }
// Keep executable lookup and network routing, but never inherit model credentials or user configuration.
for (const key of Object.keys(process.env)) delete process.env[key]
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
  if (inherited[key] !== undefined) process.env[key] = inherited[key]
}
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
  DSH_AGENTS_HOME: join(home, '.agents'), DSH_TELEMETRY_DISABLED: '1',
  XDG_CACHE_HOME: join(directory, 'cache'), XDG_CONFIG_HOME: join(home, '.config'),
  APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
  LOGIC_MARGIN_HOME: nativeHome, LOGIC_MARGIN_DATA_DIR: dataDir,
  TMPDIR: directory, TMP: directory, TEMP: directory,
})
await mkdir(home, { recursive: true })
const work = join(directory, 'work')
await mkdir(work)
process.chdir(work)
const report = {
  startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.version,
  archiveSHA256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  tests: {}, toolsCalled: [], modelPromptsSubmitted: 0, realProfilesTouched: false,
  limits: ['No Desktop/UI or model-inference acceptance', 'Only this host platform executes the native launcher', 'Caller cancellation is observable; remote handler cancellation is not instrumented'],
}
const mark = (name, value = true) => { report.tests[name] = value; console.log(`[dsh] ${name}: ${JSON.stringify(value)}`) }
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const hash = text => createHash('sha256').update(text).digest('hex')
const bounded = async (promise, ms, label) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) })]) }
  finally { clearTimeout(timer) }
}
const cli = async args => {
  // Use the installed CLI entry directly: personal shell wrappers can derive their install path from HOME.
  const { stdout } = await run(process.execPath, [join(dshRoot, 'lib/bin.js'), ...args], {
    cwd: work, env: process.env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}
let ctx, app, packageDir, base, isolatedRegistry
const writeReport = async value => {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(value, null, 2) + '\n')
}
const closeHost = async () => {
  if (!app) return
  // DSH may force process.exit on teardown failure; persist failure first and never exit successfully.
  await writeReport({ ...report, ok: false, error: { name: 'CleanupIncomplete', message: 'Default Web Host cleanup did not settle' }, finishedAt: new Date().toISOString() })
  const exitCode = process.exitCode ?? 0
  process.exitCode = 1
  await app.shutdown.shutdown(1)
  process.exitCode = exitCode
  app = undefined
  ctx = undefined
}
const native = async args => {
  assert.ok(packageDir, 'The actual installed bundle must exist before invoking its launcher')
  const { launcherCommand } = await import('../plugins/deepseek-harness/native.js')
  const resources = join(packageDir, 'resources/logic-margin')
  const [command, prefix] = launcherCommand(resources)
  const { stdout } = await run(command, [...prefix, ...args], {
    cwd: work, env: process.env, timeout: 20_000, maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout)
}
const registry = async () => {
  const value = await json(join(nativeHome, 'daemon.json'))
  assert.equal(resolve(value.dataDir), dataDir, 'Refuse any service outside the isolated data directory')
  const url = new URL(value.url)
  assert.equal(url.hostname, '127.0.0.1')
  isolatedRegistry = value
  base = value.url
  return value
}
const stop = async () => {
  let value
  try { value = await registry() } catch (error) { if (error.code === 'ENOENT') return; throw error }
  assert.equal(value.dataDir, dataDir)
  const stopped = await native(['server', 'stop'])
  if (!stopped.stopped) {
    try { process.kill(value.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    throw new Error('Isolated service stop was not confirmed')
  }
  const deadline = performance.now() + 5000
  do {
    try { process.kill(value.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await delay(50)
  } while (performance.now() < deadline)
  throw new Error('Isolated daemon did not exit within 5000ms')
}

try {
  const hostManifest = await json(join(dshRoot, 'package.json'))
  assert.equal(hostManifest.version, '0.2.2-rc.1', 'This integration baseline is intentionally version-specific')
  report.dshVersion = hostManifest.version
  await cli(['--profile', profileName, '--from-default-profile', 'web', '--dump-config'])
  await cli(['plugin', '--profile', profileName, 'add', archive, '--ignore-scripts', '--store-dir', join(directory, 'pnpm-store')])
  const composed = await cli(['--profile', profileName, '--dump-config'])
  assert.match(composed, /logic-margin/)
  mark('actualTgzInstalledIntoTemporaryProfile')

  const installAnchor = join(dshRoot, 'package.json'), hostRequire = createRequire(installAnchor)
  const hostImport = name => import(pathToFileURL(hostRequire.resolve(name)).href)
  const { loadProfile } = await hostImport('@deepseek-ai/dsh-app-boot')
  const { ToolCallId } = await hostImport('@deepseek-ai/dsh-llm')
  const { createLaunchEnvironmentSnapshot } = await hostImport('@deepseek-ai/dsh-launch-environment')
  const { runProfile } = await import(pathToFileURL(join(dshRoot, 'lib/profile-boot.js')).href)
  const profile = loadProfile('dsh', profileName, installAnchor, dshHome, { userLayer: false })
  assert.deepEqual(profile.skippedBundles, [])
  const layer = profile.layers.find(value => value.packageName === 'dsh-plugin-logicmargin')
  assert.ok(layer, 'Real profile bundle discovery must find LogicMargin')
  packageDir = layer.packageDir
  const mount = async () => {
    // The default Web startup prints a temporary login token; keep it out of test logs.
    const log = console.log
    console.log = (...values) => { if (!String(values[0]).startsWith('dsh web: ')) log(...values) }
    try {
      app = await bounded(runProfile({
        environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
        profile: profileName, patchFiles: [], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
      }), 310_000, 'Default Web profile activation')
    } finally { console.log = log }
    const context = app.ctx
    const pluginURL = pathToFileURL(join(packageDir, 'index.js')).href
    const peers = {}
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-subprocess']) {
      const actual = context.pluginPackages.packageOf(name, pluginURL)
      assert.ok(actual, `${name} must resolve through the host profile resolver`)
      const expected = hostRequire.resolve(`${name}/package.json`)
      assert.equal(resolve(actual.manifestPath), resolve(expected), `${name} must share the installation instance`)
      peers[name] = actual.version
    }
    report.peerVersions = peers
    return context
  }
  console.log('[dsh] activating actual package; fixed-version native release may download into isolated cache')
  ctx = await mount()
  assert.equal(ctx.webServer.host, '127.0.0.1')
  mark('fullDefaultWebProfileWithoutModelPrompt')
  const running = await registry()
  assert.equal(running.version, '0.9.6')
  const initialPid = running.pid
  const installedBinary = join(process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME, 'logic-margin/native/0.9.6',
    process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch === 'x64' ? 'x64' : 'arm64'}`,
    process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin')
  report.nativeVersion = running.version
  report.nativeBinarySHA256 = hash(await readFile(installedBinary))
  mark('realLoaderNativeActivation')
  const catalog = await ctx.skills.list()
  assert.ok(catalog.some(value => value.name === 'logic-margin'))
  const skill = await ctx.skills.get('logic-margin')
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.ok(resolve(skill.resourceBase.path).startsWith(resolve(packageDir)))
  assert.doesNotMatch(skill.content, /^---/)
  assert.match(skill.content, /DeepSeek Harness/)
  assert.match(skill.content, /不要运行 Codex 专用 `server setup`/)
  const resource = await readFile(join(skill.resourceBase.path, 'references/mcp-workflow.md'), 'utf8')
  assert.match(resource, /mcp__logic_margin__wait_review/)
  mark('bundledSkillAndRelativeResources')
  const rawNames = ['start_review', 'verify_review', 'attach_review_baseline', 'get_review', 'list_reviews', 'wait_review', 'acknowledge_review', 'reply_review', 'revise_review', 'cleanup_review', 'restore_review']
  const schemas = ctx.tools.schemas().map(value => value.name)
  for (const name of rawNames) assert.ok(schemas.includes(`mcp__logic_margin__${name}`), name)
  mark('allElevenMcpToolsDiscovered')
  const webOrigin = ctx.webServer.getOrigin()
  const login = await fetch(ctx.connection.authenticatedUrl(webOrigin), { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.equal(login.status, 303)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie)
  const webRpc = async (method, args) => {
    const response = await fetch(`${webOrigin}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: webOrigin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.result.ok, true, `${method} failed`)
    return result.result.value
  }
  const inventory = await webRpc('pluginInventory/list', {})
  const configured = [...ctx.loader.entries()].find(value => value.options.id === 'logic-margin')
  assert.ok(configured)
  assert.ok(inventory.entries.some(value => value.entryId === configured.id && value.fiberPhase === 'active'))
  const webSession = await webRpc('session/create', { request: { cwd: work, agentPreset: 'standard' } })
  const skills = await webRpc('skills/list', { request: { sessionId: webSession.sessionId } })
  assert.ok(skills.skills.some(value => value.name === 'logic-margin'))
  mark('authenticatedWebInventoryAndSessionSkillCatalog', { agentSessionCreated: true, modelPromptSubmitted: false })
  let serial = 0
  const execute = async (name, args, signal = AbortSignal.timeout(30_000)) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`logic-margin-integration-${++serial}`), name: `mcp__logic_margin__${name}`, arguments: JSON.stringify(args) }], signal,
    })
    assert.equal(batch.results.length, 1)
    return batch.results[0].result
  }
  const call = async (name, args, signal) => {
    const result = await execute(name, args, signal)
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`)
    const text = result.content.filter(value => value.type === 'text').map(value => value.text).join('\n')
    if (!report.toolsCalled.includes(name)) report.toolsCalled.push(name)
    return JSON.parse(text)
  }
  const http = async (path, body) => {
    const response = await fetch(base + '/api/review-sessions' + path, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    const value = await response.json()
    assert.ok(response.ok, `Synthetic review HTTP ${response.status}: ${JSON.stringify(value)}`)
    return value
  }
  const sourceRoot = join(work, 'source')
  await mkdir(sourceRoot)
  const source = 'package fixture\nfunc Evaluate(value int) int { return value + 1 }\n'
  await writeFile(join(sourceRoot, 'fixture.go'), source)
  const files = [{ path: 'fixture.go', sha256: hash(source) }]
  const review = {
    schemaVersion: 1, id: 'dsh-synthetic-review', title: 'DSH isolated lifecycle', description: 'Synthetic source-backed integration only', revision: 'synthetic-r1',
    snapshot: { repository: 'synthetic', commit: 'fixed-integration-input', fingerprint: hash(JSON.stringify(files)), files, capturedAt: new Date().toISOString(), dirty: true },
    coverage: { included: ['Synthetic Evaluate function'], excluded: ['User repositories and production sessions'], note: 'No user materials are read' },
    scenes: [{ id: 'flow', title: 'Synthetic flow', description: '' }],
    nodes: [{ id: 'evaluate', sceneId: 'flow', title: 'Evaluate', kind: 'action', summary: 'Add one', detail: '', input: 'value', output: 'value + 1', position: { x: 0, y: 0 },
      evidence: [{ path: 'fixture.go', symbol: 'Evaluate', startLine: 1, endLine: 2, digest: hash(source.trimEnd()) }] }],
    edges: [], comments: [],
  }
  const reviewFile = join(work, 'review.json')
  await writeFile(reviewFile, JSON.stringify(review))
  await call('verify_review', { review_file: reviewFile, source_root: sourceRoot })
  const started = await call('start_review', { review_file: reviewFile, source_root: sourceRoot, purpose: 'DSH isolated lifecycle', context: 'isolated-integration' })
  const session = started.sessionId
  assert.ok(session)
  let state = await call('get_review', { session_id: session })
  assert.equal(state.id, session)
  assert.equal(state.review.nodes[0].evidence[0].code, source.trimEnd())
  const listed = await call('list_reviews', { context: 'isolated-integration', state: 'all' })
  assert.ok(listed.sessions.some(value => value.id === session))
  await call('attach_review_baseline', { session_id: session, baseline_file: reviewFile, source_root: sourceRoot })
  mark('sourceVerifiedStartReadListAndBaseline')

  const waitController = new AbortController()
  const waitStarted = performance.now()
  let waitSettled = false
  const waiting = call('wait_review', { session_id: session }, waitController.signal).finally(() => { waitSettled = true })
  // Attach a rejection handler immediately; assert the original outcome after the intended >60 second interval.
  waiting.catch(() => {})
  try {
    for (let second = 0; second < 65; second += 5) {
      await delay(5000)
      assert.equal(waitSettled, false, `wait_review ended at ${Math.round(performance.now() - waitStarted)}ms without human submission`)
      console.log(`[dsh] wait_review remains pending after ${second + 5}s`)
    }
    state = await http(`/${session}`)
    const commentId = randomUUID()
    const comment = { id: commentId, body: 'Synthetic reviewer requests adding two', targets: [{ kind: 'node', id: 'evaluate' }], status: 'open', createdAt: new Date().toISOString(), revision: state.review.revision }
    state = await http(`/${session}/mutations`, { round: state.round, revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment }] })
    await delay(300)
    assert.equal(waitSettled, false, 'Saving a comment must not complete wait_review')
    state = await http(`/${session}/finish`, { expectedVersion: state.version, kind: 'feedback' })
    const feedback = await bounded(waiting, 10_000, 'Submitted feedback delivery')
    assert.equal(feedback.approved, false)
    assert.equal(feedback.submission.id, state.history.at(-1).id)
    assert.equal(feedback.requiresAcknowledgement, true)
    assert.equal(feedback.submission.review.comments[0].id, commentId)
    state = await http(`/${session}`)
    assert.equal(state.phase, 'feedback-ready')
    assert.equal(state.acknowledgedSubmission, undefined)
    await access(join(dataDir, `${session}.json`))
    mark('waitBeyondDefaultSixtySeconds', { elapsedMs: Math.round(performance.now() - waitStarted), savedCommentDoesNotReturn: true, fixedFeedback: true, automaticAck: false, automaticArchive: false })

    await call('acknowledge_review', { session_id: session, submission_id: feedback.submission.id })
    const controller = new AbortController()
    const canceled = execute('wait_review', { session_id: session, after_submission: feedback.submission.id }, controller.signal)
    await delay(1000)
    const cancelStarted = performance.now()
    controller.abort(new Error('isolated integration cancellation'))
    const cancellation = await bounded(canceled, 10_000, 'Caller wait cancellation')
    assert.equal(cancellation.isError, true)
    state = await http(`/${session}`)
    assert.equal(state.acknowledgedSubmission, feedback.submission.id)
    assert.equal(state.history.length, 1)
    await access(join(dataDir, `${session}.json`))
    mark('callerCancellationPreservesSession', { elapsedMs: Math.round(performance.now() - cancelStarted), isError: true, newAcknowledgement: false, archive: false, remoteHandlerCancellationProven: false })
    await call('reply_review', { session_id: session, comment_id: commentId, body: 'Synthetic agent will implement adding two' })

    const changedSource = source.replace('value + 1', 'value + 2')
    await writeFile(join(sourceRoot, 'fixture.go'), changedSource)
    review.revision = 'synthetic-r2'
    review.nodes[0].summary = 'Add two'
    review.nodes[0].output = 'value + 2'
    review.nodes[0].evidence[0].digest = hash(changedSource.trimEnd())
    review.snapshot.files[0].sha256 = hash(changedSource)
    review.snapshot.fingerprint = hash(JSON.stringify(review.snapshot.files))
    await writeFile(reviewFile, JSON.stringify(review))
    await call('revise_review', { session_id: session, review_file: reviewFile, source_root: sourceRoot, base_round: 1, summary: 'Synthetic implementation adds two' })
    state = await http(`/${session}`)
    assert.equal(state.round, 2)
    assert.equal(state.review.baseline.nodes[0].evidence[0].code, source.trimEnd())
    assert.equal(state.review.nodes[0].evidence[0].code, changedSource.trimEnd())
    const currentComment = state.review.comments.find(value => value.id === commentId)
    assert.ok(currentComment.replies.some(value => value.author === 'agent'))
    state = await http(`/${session}/mutations`, {
      expectedVersion: state.version, round: state.round, revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint,
      mutations: [{ kind: 'set-status', commentId, status: 'resolved', from: currentComment.status, reviewedRevision: state.review.revision }],
    })
    state = await http(`/${session}/finish`, { expectedVersion: state.version, kind: 'approval' })
    const approved = await call('wait_review', { session_id: session, after_submission: feedback.submission.id })
    assert.equal(approved.approved, true)
    assert.equal(approved.round, 2)
    await call('cleanup_review', { session_id: session })
    await access(join(dataDir, 'archive', `${session}.json.gz`))
    const archived = await call('get_review', { session_id: session })
    assert.equal(archived.id, session)
    await call('restore_review', { session_id: session })
    const restored = await call('get_review', { session_id: session })
    assert.equal(restored.id, session)
    assert.equal(restored.round, 2)
    assert.equal(restored.history.length, 2)
    assert.equal(restored.review.snapshot.fingerprint, review.snapshot.fingerprint)
    mark('feedbackReviseHumanApprovalArchiveRestore')

    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'logic-margin')
    assert.ok(entry?.fiber, 'Real Loader owns the plugin fiber')
    await bounded(entry.fiber.dispose(), 10_000, 'Bundle unload')
    assert.ok(!ctx.tools.schemas().some(value => value.name.startsWith('mcp__logic_margin__')))
    assert.equal(await ctx.skills.get('logic-margin'), undefined)
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) }).then(value => value.json())
    assert.equal(health.pid, initialPid)
    mark('unloadWithdrawsToolsAndSkillButRetainsSharedDaemon')
    const previousURL = base
    await stop()
    await closeHost()
    await native(['server', 'start'])
    await registry()
    assert.equal(base, previousURL, 'Restart must preserve the registered port')
    assert.notEqual(isolatedRegistry.pid, initialPid)
    ctx = await mount()
    const resumed = await call('get_review', { session_id: session })
    assert.deepEqual(resumed, restored)
    mark('explicitReloadAfterNativeRestartResumesSameSession', { sameSession: true, sameMaterials: true, oldInflightWaitResumed: false })
    assert.deepEqual([...report.toolsCalled].sort(), [...rawNames].sort())
    mark('allElevenMcpToolsCalled')
  } finally { waitController.abort(new Error('Integration wait cleanup')) }
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  const cleanup = []
  if (packageDir) {
    try { await stop() } catch (error) { cleanup.push(`Isolated service stop: ${error.message}`) }
  }
  if (cleanup.length) report.cleanupErrors = cleanup
  if (app) {
    try { await closeHost() } catch (error) { cleanup.push(`Host disposal: ${error.message}`) }
  }
  if (cleanup.length) { report.cleanupErrors = cleanup; report.ok = false; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeReport(report)
  console.log(`[dsh] report ${output}; ok=${report.ok}`)
  if (!report.ok) console.error(JSON.stringify({ error: report.error, cleanupErrors: report.cleanupErrors }))
}
