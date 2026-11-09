import assert from 'node:assert/strict'
import childProcess, { execFile, spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { configureCodexMcp } from './mcp-config.ts'

const url = 'http://127.0.0.1:50123/mcp'
const execute = promisify(execFile)

async function setup(t: { after(callback: () => Promise<void>): void }, config: object, mode = 'normal') {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-mcp-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = join(directory, 'state.json'), log = join(directory, 'requests.jsonl'), pid = join(directory, 'pid')
  await writeFile(state, JSON.stringify(config))
  const program = join(directory, 'fake-codex.mjs')
  await writeFile(program, `import {createInterface} from 'node:readline'; import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const state=${JSON.stringify(state)}, log=${JSON.stringify(log)}, mode=${JSON.stringify(mode)};
writeFileSync(${JSON.stringify(pid)},String(process.pid));
let config=JSON.parse(readFileSync(state,'utf8'));
for await(const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line); appendFileSync(log,JSON.stringify(message)+'\\n');
 if(mode==='exit')process.exit(1);
 if(mode==='timeout'||message.id===undefined)continue;
 let result={};
 if(message.method==='config/read')result={config,layers:[{name:{type:'user',profile:null},version:'fixture-version'}]};
 if(message.method==='config/batchWrite') {
  if(mode==='error'){console.error('fixture-secret');console.log(JSON.stringify({id:message.id,error:{code:-1,message:'fixture-secret'}}));continue;}
  for(const edit of message.params.edits){const keys=edit.keyPath.split('.');let current=config;for(const key of keys.slice(0,-1))current=current[key]??={};current[keys.at(-1)]=edit.value;}
  writeFileSync(state,JSON.stringify(config));
 }
 console.log(JSON.stringify({id:message.id,result}));
}
`)
  return { directory, state, pid, command: [process.execPath, program], requests: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

test('setup registers only its HTTP endpoint and timeout, preserving other configuration', async t => {
  const fixture = await setup(t, { model: 'keep-model', mcp_servers: { other: { command: 'keep-command' } } })
  assert.deepEqual(await configureCodexMcp(url, { command: fixture.command }), {
    serverName: 'logic_margin', url, toolTimeoutSec: 86400, reloadRequired: true,
  })
  assert.deepEqual(JSON.parse(await readFile(fixture.state, 'utf8')), {
    model: 'keep-model', mcp_servers: { other: { command: 'keep-command' }, logic_margin: { url, tool_timeout_sec: 86400 } },
  })
  const requests = await fixture.requests()
  assert.deepEqual(requests.map(value => value.method), ['initialize', 'initialized', 'config/read', 'config/batchWrite', 'config/read'])
  const write = requests.find(value => value.method === 'config/batchWrite')
  assert.equal(write.params.expectedVersion, 'fixture-version')
  assert.deepEqual(write.params.edits.map((value: { keyPath: string }) => value.keyPath), ['mcp_servers.logic_margin.url', 'mcp_servers.logic_margin.tool_timeout_sec'])
})

test('repeat setup preserves a longer timeout without rewriting the configuration', async t => {
  const fixture = await setup(t, { mcp_servers: { logic_margin: { url, enabled: true, tool_timeout_sec: 172800, disabled_tools: ['kept-tool'] } } })
  const original = await readFile(fixture.state, 'utf8')
  const result = await configureCodexMcp(url, { command: fixture.command })
  assert.equal(result.toolTimeoutSec, 172800)
  assert.equal(await readFile(fixture.state, 'utf8'), original)
  assert.equal((await fixture.requests()).some(value => value.method === 'config/batchWrite'), false)
})

test('conflicting or disabled same-name services are preserved', async t => {
  for (const entry of [{ url: 'http://127.0.0.1:50124/mcp' }, { command: 'existing-stdio' }, { url, enabled: false }]) {
    const fixture = await setup(t, { mcp_servers: { logic_margin: entry } })
    const original = await readFile(fixture.state, 'utf8')
    await assert.rejects(configureCodexMcp(url, { command: fixture.command }), /同名|禁用/)
    assert.equal(await readFile(fixture.state, 'utf8'), original)
    assert.equal((await fixture.requests()).some(value => value.method === 'config/batchWrite'), false)
  }
})

test('invalid endpoints are rejected before launching any configuration process', async t => {
  const fixture = await setup(t, {})
  for (const endpoint of ['https://127.0.0.1/mcp', 'http://example.com/mcp', 'http://127.0.0.1/api', 'http://user@127.0.0.1/mcp', `${url}?token=x`, `${url}#fragment`]) {
    await assert.rejects(configureCodexMcp(endpoint, { command: fixture.command }), /本机 HTTP/)
  }
  await assert.rejects(readFile(fixture.pid), { code: 'ENOENT' })
})

test('timeouts, early exits and API failures close the temporary process without exposing its output', async t => {
  const spawn = childProcess.spawn
  const children: number[] = []
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    if (child.pid) children.push(child.pid)
    return child
  })
  syncBuiltinESMExports()
  try {
    for (const mode of ['timeout', 'exit', 'error']) {
      children.length = 0
      const fixture = await setup(t, {}, mode)
      await assert.rejects(configureCodexMcp(url, { command: fixture.command, timeoutMs: mode === 'timeout' ? 200 : 2000 }), error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /超时|提前退出|拒绝操作/)
        assert.doesNotMatch(error.message, /fixture-secret/)
        return true
      })
      assert.equal(children.length, 1)
      assert.throws(() => process.kill(children[0], 0), { code: 'ESRCH' })
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('real Codex config APIs preserve unrelated TOML and survive an idempotent setup', { skip: spawnSync('codex', ['--version'], { stdio: 'ignore' }).status !== 0 }, async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-real-codex-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'config.toml')
  await writeFile(config, '# Preserve this comment\nmodel = "preserved-test-model"\n[mcp_servers.kept]\nurl = "http://127.0.0.1:50124/mcp"\n')
  const caller = join(directory, 'setup.mjs')
  const module = pathToFileURL(fileURLToPath(new URL('./mcp-config.ts', import.meta.url))).href
  await writeFile(caller, `import {configureCodexMcp} from ${JSON.stringify(module)};console.log(JSON.stringify(await configureCodexMcp(${JSON.stringify(url)})));`)
  const run = () => execute(process.execPath, [caller], { cwd: directory, env: { ...process.env, CODEX_HOME: directory }, timeout: 15000 })
  assert.equal(JSON.parse((await run()).stdout).toolTimeoutSec, 86400)
  const first = await readFile(config, 'utf8')
  assert.match(first, /# Preserve this comment/)
  assert.match(first, /model = "preserved-test-model"/)
  assert.match(first, /\[mcp_servers\.kept\]/)
  assert.match(first, /\[mcp_servers\.logic_margin\]/)
  assert.match(first, /tool_timeout_sec = 86400/)
  assert.equal(JSON.parse((await run()).stdout).reloadRequired, true)
  assert.equal(await readFile(config, 'utf8'), first)
})
