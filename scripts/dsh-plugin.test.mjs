import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { launcherCommand, startNativeServer, validateServer } from '../plugins/deepseek-harness/native.js'
import { harnessSkill, packageDsh } from './package-dsh.mjs'

const run = promisify(execFile)
const root = new URL('../', import.meta.url)
const temporary = async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-dsh-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const server = { managed: true, url: 'http://127.0.0.1:57123', mcpUrl: 'http://127.0.0.1:57123/mcp' }

test('native startup accepts only confirmed local MCP endpoints', () => {
  for (const host of ['127.0.0.1:57123', 'localhost:80', '[::1]:57123']) {
    const value = validateServer({ managed: true, url: `http://${host}`, mcpUrl: `http://${host}/mcp` })
    assert.equal(new URL(value.mcpUrl).origin, value.url)
  }
  for (const value of [null, {}, { ...server, managed: false }, { ...server, url: 'http://localhost:57124' },
    { ...server, mcpUrl: 'https://127.0.0.1:57123/mcp' }, { ...server, mcpUrl: 'http://example.com/mcp' },
    { ...server, mcpUrl: 'http://user@127.0.0.1:57123/mcp' }, { ...server, mcpUrl: server.mcpUrl + '?secret=x' },
    { ...server, url: server.url + '/other' }, { ...server, mcpUrl: server.url + '/api' }]) assert.throws(() => validateServer(value))
})

test('launchers preserve platform arguments and never use the Codex setup command', () => {
  const windows = launcherCommand('/package with spaces/resources', 'win32')
  assert.equal(windows[0], 'powershell.exe')
  assert.ok(windows[1].includes('-File'))
  assert.ok(windows[1].at(-1).endsWith('logic-margin.ps1'))
  assert.equal(launcherCommand('/package with spaces/resources', 'linux')[0], '/bin/sh')
  assert.throws(() => launcherCommand('/package', 'other'), /Unsupported/)
})

test('invalid configuration and pre-cancellation never launch a child', async () => {
  const controller = new AbortController()
  controller.abort(new Error('already cancelled'))
  await assert.rejects(startNativeServer('/missing', {}, controller.signal, {}), /already cancelled/)
  for (const config of [{ home: 'relative' }, { port: -1 }, { port: 1.5 }, { port: 65536 }]) {
    await assert.rejects(startNativeServer('/missing', config, new AbortController().signal, {}), /absolute path|integer/)
  }
})

test('DSH skill keeps the review protocol and replaces only the host-specific bootstrap', async () => {
  assert.deepEqual(await readFile(new URL('plugins/logic-margin/LICENSE', root)), await readFile(new URL('LICENSE', root)), 'Sparse Codex installs and generated DSH bundles must share the project license')
  const source = await readFile(new URL('plugins/logic-margin/skills/logic-margin/SKILL.md', root), 'utf8')
  const skill = harnessSkill(source)
  assert.equal(skill.slice(skill.indexOf('## 发起审查\n')), source.slice(source.indexOf('## 发起审查\n')))
  assert.match(skill, /mcp__logic_margin__wait_review/)
  assert.match(skill, /不要运行 Codex 专用 `server setup`/)
  assert.doesNotMatch(skill, /首次尚未注册时执行 `server setup`/)
  assert.throws(() => harnessSkill('unexpected workflow'), /markers changed/)
})

test('packed tgz contains pinned launchers, DSH skill resources and no Codex installers or native payload', async t => {
  const directory = await temporary(t)
  const archive = await packageDsh(directory)
  const entries = (await run('tar', ['-tzf', archive])).stdout.trim().split(/\r?\n/)
  for (const path of ['package/index.js', 'package/native.js', 'package/cordis.patch.yml', 'package/icon.svg', 'package/locale/en.json', 'package/locale/zh.json', 'package/LICENSE',
    'package/resources/logic-margin/plugin.json', 'package/resources/logic-margin/skills/logic-margin/SKILL.md',
    'package/resources/logic-margin/skills/logic-margin/scripts/logic-margin.sh', 'package/resources/logic-margin/skills/logic-margin/scripts/logic-margin.ps1',
    'package/resources/logic-margin/skills/logic-margin/references/review-format.md']) assert.ok(entries.includes(path), path)
  assert.ok(entries.every(path => !path.includes('node_modules') && !path.includes('.logic-margin/') && !path.includes('openai.yaml')))
  assert.ok(!entries.some(path => /scripts\/logic-margin(?:\.exe)?$/.test(path)))
  const read = path => run('tar', ['-xOf', archive, path]).then(result => result.stdout)
  const manifest = JSON.parse(await read('package/package.json'))
  assert.equal(manifest.engines.dsh, '0.2.2-rc.1')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.license, 'MIT')
  assert.equal(await read('package/LICENSE'), await readFile(new URL('LICENSE', root), 'utf8'))
  assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${archive.split(/[\\/]/).at(-1)}\n`)
  assert.equal(JSON.parse(await read('package/resources/logic-margin/plugin.json')).version, manifest.version)
  for (const name of ['index.js', 'native.js']) assert.equal(await read(`package/${name}`), await readFile(new URL(`plugins/deepseek-harness/${name}`, root), 'utf8'))
  assert.equal(await read('package/resources/logic-margin/skills/logic-margin/SKILL.md'), harnessSkill(await readFile(new URL('plugins/logic-margin/skills/logic-margin/SKILL.md', root), 'utf8')))
  for (const name of ['logic-margin.sh', 'logic-margin.ps1']) assert.equal(await read(`package/resources/logic-margin/skills/logic-margin/scripts/${name}`), await readFile(new URL(`plugins/logic-margin/skills/logic-margin/scripts/${name}`, root), 'utf8'))
  assert.doesNotMatch(await read('package/resources/logic-margin/skills/logic-margin/references/plugin-updates.md'), /codex plugin add/)
})

for (const mode of ['success', 'failure', 'invalid', 'cancel', 'stubborn']) test(`startup ${mode} uses an isolated home and bounded real child`, { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t), resources = join(directory, 'resources with spaces'), scripts = join(resources, 'skills/logic-margin/scripts')
  await mkdir(scripts, { recursive: true })
  const capture = join(directory, 'capture.json')
  await writeFile(join(resources, 'plugin.json'), JSON.stringify({ name: 'logic-margin', version: '0.9.6' }))
  await cp(new URL('plugins/logic-margin/skills/logic-margin/scripts/logic-margin.sh', root), join(scripts, 'logic-margin.sh'))
  const binary = join(scripts, 'logic-margin')
  await writeFile(binary, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';if(process.argv[2]==='--version'){console.log('0.9.6');process.exit()}if(${JSON.stringify(mode)}==='stubborn')process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),home:process.env.LOGIC_MARGIN_HOME,dataDir:process.env.LOGIC_MARGIN_DATA_DIR,pid:process.pid}));if(['cancel','stubborn'].includes(${JSON.stringify(mode)}))await new Promise(resolve=>setTimeout(resolve,30000));if(${JSON.stringify(mode)}==='failure'){console.error('fixture-private-output');process.exit(1)}console.log(${JSON.stringify(mode === 'invalid' ? 'broken' : JSON.stringify(server))});\n`)
  await chmod(binary, 0o755)
  const controller = new AbortController(), config = { home: join(directory, 'home'), port: 0 }, dataDir = join(directory, 'reviews')
  const pending = startNativeServer(resources, config, controller.signal, { PATH: process.env.PATH, LOGIC_MARGIN_DATA_DIR: dataDir })
  if (mode === 'cancel' || mode === 'stubborn') {
    for (let i = 0; i < 100; i++) { try { await readFile(capture); break } catch { await new Promise(resolve => setTimeout(resolve, 20)) } }
    controller.abort(new Error('test cancellation'))
  }
  if (mode === 'success') assert.deepEqual(await pending, { url: server.url, mcpUrl: server.mcpUrl })
  else await assert.rejects(pending, error => { assert.doesNotMatch(error.message, /fixture-private-output/); return true })
  const captured = JSON.parse(await readFile(capture, 'utf8'))
  assert.deepEqual(captured.args, ['server', 'start', '--port', '0'])
  assert.equal(captured.home, config.home)
  assert.equal(captured.dataDir, dataDir)
  if (mode === 'cancel' || mode === 'stubborn') assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' })
})
