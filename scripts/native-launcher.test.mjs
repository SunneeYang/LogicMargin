import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const source = new URL('../plugins/logic-margin/skills/logic-margin/scripts/', import.meta.url)
const version = JSON.parse(await readFile(new URL('../plugins/logic-margin/plugin.json', import.meta.url), 'utf8')).version
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const psQuote = value => `'${value.replaceAll("'", "''")}'`
const cliArgs = ['start', 'file with spaces.json', '', 'a"b', "a'b", 'a\\"b', 'ends\\', '$HOME; `echo unsafe`', '中文', '--flag']
const stub = `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = --version ]; then printf '%s\\n' "$FAKE_NATIVE_VERSION"; exit 0; fi
printf '%s\\0' "$@" > "$FAKE_NATIVE_ARGS"
umask > "$FAKE_NATIVE_UMASK"
exit "\${FAKE_EXIT_CODE:-0}"
`

async function run(command, args, options) {
  try { return { code: 0, ...await execute(command, args, { timeout: 15000, ...options }) } }
  catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function fixture(t, { system = 'Linux', machine = 'x86_64', target = 'linux-x64' } = {}) {
  const root = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-launcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const plugin = join(root, 'marketplace with spaces', 'plugins', 'logic-margin')
  const scripts = join(plugin, 'skills', 'logic-margin', 'scripts')
  const commands = join(root, 'fake commands')
  const home = join(root, 'user home')
  const cache = join(root, 'user cache')
  const installed = join(cache, 'logic-margin', 'native', version, target)
  await Promise.all([scripts, commands, home, cache].map(path => mkdir(path, { recursive: true })))
  const launcher = join(scripts, 'logic-margin.sh')
  await copyFile(new URL('logic-margin.sh', source), launcher)
  await chmod(launcher, 0o755)
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ name: 'logic-margin', version }))
  const sentinel = join(home, '.logic-margin', 'sessions', 'keep.json')
  await mkdir(dirname(sentinel), { recursive: true })
  await writeFile(sentinel, 'existing live review')
  const trace = join(root, 'commands.log')
  await writeFile(trace, '')
  const env = {
    ...process.env, PATH: `${commands}:/usr/bin:/bin`, HOME: home, XDG_CACHE_HOME: cache,
    FAKE_SYSTEM: system, FAKE_MACHINE: machine, FAKE_NATIVE_VERSION: version,
    FAKE_NATIVE_ARGS: join(root, 'received-args'), FAKE_NATIVE_UMASK: join(root, 'received-umask'), FAKE_TRACE: trace,
  }
  const command = async (name, content) => {
    const path = join(commands, name)
    await writeFile(path, '#!/bin/sh\nset -eu\n' + content)
    await chmod(path, 0o755)
  }
  await command('uname', 'case "$1" in -s) printf "%s\\n" "$FAKE_SYSTEM" ;; -m) printf "%s\\n" "$FAKE_MACHINE" ;; *) exit 1 ;; esac\n')
  await command('curl', `printf 'curl' >> "$FAKE_TRACE"
for arg do printf '\\t%s' "$arg" >> "$FAKE_TRACE"; done
printf '\\n' >> "$FAKE_TRACE"
[ "\${FAKE_NETWORK_FAILURE:-0}" = 0 ] || exit 22
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift 2; else url=$1; shift; fi
done
case "$url" in *.sha256) cp "$FAKE_CHECKSUM" "$output" ;; *.zip) cp "$FAKE_ARCHIVE" "$output" ;; *) exit 1 ;; esac
`)
  const unzip = (await execute('/bin/sh', ['-c', 'command -v unzip'])).stdout.trim()
  await command('unzip', `printf 'unzip\\n' >> "$FAKE_TRACE"\nexec ${shellQuote(unzip)} "$@"\n`)
  const invoke = (args = cliArgs, overrides = {}, path = launcher) => run(path, args, { cwd: home, env: { ...env, ...overrides } })
  const assertUntouched = async () => assert.equal(await readFile(sentinel, 'utf8'), 'existing live review')
  const archive = async ({ executable = stub, entry = true, checksum } = {}) => {
    const name = `logic-margin-agent-${version}-${target}`
    const staging = join(root, 'archive staging')
    const expectedEntry = `${name}/plugins/logic-margin/skills/logic-margin/scripts/logic-margin`
    await mkdir(dirname(join(staging, expectedEntry)), { recursive: true })
    if (entry) await writeFile(join(staging, expectedEntry), executable)
    const extra = `${name}/sessions/do-not-extract.json`
    await mkdir(dirname(join(staging, extra)), { recursive: true })
    await writeFile(join(staging, extra), 'must never be extracted')
    env.FAKE_ARCHIVE = join(root, `${name}.zip`)
    await execute('zip', ['-q', env.FAKE_ARCHIVE, ...(entry ? [expectedEntry] : []), extra], { cwd: staging })
    const digest = createHash('sha256').update(await readFile(env.FAKE_ARCHIVE)).digest('hex')
    env.FAKE_CHECKSUM = `${env.FAKE_ARCHIVE}.sha256`
    await writeFile(env.FAKE_CHECKSUM, checksum ?? `${digest}  ${name}.zip\n`)
  }
  return { root, scripts, launcher, installed, env, trace, invoke, archive, assertUntouched }
}

const posix = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn)

posix('adjacent native binary keeps every argument and exit code through a symlink with spaces', async t => {
  const f = await fixture(t)
  await writeFile(join(f.scripts, 'logic-margin'), stub, { mode: 0o755 })
  const link = join(f.root, 'symlink with spaces.sh')
  await symlink('marketplace with spaces/plugins/logic-margin/skills/logic-margin/scripts/logic-margin.sh', link)
  const result = await f.invoke(cliArgs, { FAKE_EXIT_CODE: '37' }, link)
  assert.equal(result.code, 37, result.stderr)
  assert.deepEqual((await readFile(f.env.FAKE_NATIVE_ARGS, 'utf8')).split('\0'), [...cliArgs, ''])
  assert.equal(await readFile(f.trace, 'utf8'), '')
  await f.assertUntouched()
})

posix('adjacent version mismatch fails without downloading or running CLI arguments', async t => {
  const f = await fixture(t)
  await writeFile(join(f.scripts, 'logic-margin'), stub, { mode: 0o755 })
  const result = await f.invoke(cliArgs, { FAKE_NATIVE_VERSION: '99.0.0' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /version 99\.0\.0 does not match plugin/)
  assert.equal(await readFile(f.trace, 'utf8'), '')
  await assert.rejects(readFile(f.env.FAKE_NATIVE_ARGS), { code: 'ENOENT' })
})

for (const [system, machine, target] of [
  ['Darwin', 'arm64', 'darwin-arm64'], ['Darwin', 'x86_64', 'darwin-x64'],
  ['Linux', 'aarch64', 'linux-arm64'], ['Linux', 'x86_64', 'linux-x64'],
]) posix(`verified ${target} download installs only the executable and reuses its version cache`, async t => {
  const f = await fixture(t, { system, machine, target })
  await f.archive()
  const first = await f.invoke(cliArgs, { FAKE_EXIT_CODE: '23' })
  assert.equal(first.code, 23, first.stderr)
  assert.deepEqual((await readFile(f.env.FAKE_NATIVE_ARGS, 'utf8')).split('\0'), [...cliArgs, ''])
  const url = `https://github.com/SunneeYang/LogicMargin/releases/download/v${version}/logic-margin-agent-${version}-${target}.zip`
  const trace = await readFile(f.trace, 'utf8')
  const lines = trace.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0].split('\t').at(-1), url)
  assert.equal(lines[1].split('\t').at(-1), `${url}.sha256`)
  assert.equal(lines[2], 'unzip')
  for (const line of lines.slice(0, 2)) {
    assert.ok(line.includes('\t--max-time\t120\t'))
    assert.ok(line.includes('\t--connect-timeout\t10\t'))
    assert.ok(line.includes('\t--proto\t=https\t--proto-redir\t=https\t'))
  }
  assert.deepEqual(await readdir(f.installed), ['logic-margin'])
  const second = await f.invoke(['again'], { FAKE_NETWORK_FAILURE: '1' })
  assert.equal(second.code, 0, second.stderr)
  assert.equal(await readFile(f.trace, 'utf8'), trace)
  await f.assertUntouched()
})

posix('checksum mismatch stops before extraction and leaves no partial cache executable', async t => {
  const f = await fixture(t)
  await f.archive({ checksum: `${'0'.repeat(64)}  logic-margin-agent-${version}-linux-x64.zip\n` })
  const result = await f.invoke()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /SHA-256 mismatch/)
  assert.ok(!(await readFile(f.trace, 'utf8')).includes('unzip'))
  assert.deepEqual(await readdir(f.installed), [])
  await f.assertUntouched()
})

posix('first-time download preserves the caller umask for native execution', async t => {
  const f = await fixture(t)
  await f.archive()
  const result = await run('/bin/sh', ['-c', 'umask 022; exec "$@"', 'sh', f.launcher, ...cliArgs], { env: f.env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await readFile(f.env.FAKE_NATIVE_UMASK, 'utf8')).trim(), '0022')
})

for (const checksum of ['not a digest\n', `${'0'.repeat(64)}  wrong-archive.zip\n`]) {
  posix(`rejects invalid release checksum record ${checksum.trim().slice(-20)}`, async t => {
    const f = await fixture(t)
    await f.archive({ checksum })
    const result = await f.invoke()
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Invalid release SHA-256 file/)
    assert.ok(!(await readFile(f.trace, 'utf8')).includes('unzip'))
    assert.deepEqual(await readdir(f.installed), [])
  })
}

posix('verified archive must contain the fixed executable entry', async t => {
  const f = await fixture(t)
  await f.archive({ entry: false })
  const result = await f.invoke()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Missing or invalid executable/)
  assert.deepEqual(await readdir(f.installed), [])
  await f.assertUntouched()
})

posix('downloaded executable version is checked before atomic installation', async t => {
  const f = await fixture(t)
  await f.archive({ executable: stub.replace('"$FAKE_NATIVE_VERSION"', "'99.0.0'") })
  const result = await f.invoke()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /version 99\.0\.0 does not match plugin/)
  assert.deepEqual(await readdir(f.installed), [])
})

posix('wrong cached executable version fails without downloading or replacing it', async t => {
  const f = await fixture(t)
  await mkdir(f.installed, { recursive: true })
  const content = stub.replace('"$FAKE_NATIVE_VERSION"', "'99.0.0'")
  await writeFile(join(f.installed, 'logic-margin'), content, { mode: 0o755 })
  const result = await f.invoke()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /version 99\.0\.0 does not match plugin/)
  assert.equal(await readFile(join(f.installed, 'logic-margin'), 'utf8'), content)
  assert.equal(await readFile(f.trace, 'utf8'), '')
})

posix('failed download reports the pinned URL and removes its temporary directory', async t => {
  const f = await fixture(t)
  const result = await f.invoke(cliArgs, { FAKE_NETWORK_FAILURE: '1' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, new RegExp(`Download failed: https://github.com/SunneeYang/LogicMargin/releases/download/v${version}/`))
  assert.deepEqual(await readdir(f.installed), [])
  await f.assertUntouched()
})

for (const [system, machine] of [['FreeBSD', 'x86_64'], ['Linux', 'riscv64']]) {
  posix(`unsupported ${system}/${machine} fails before downloading`, async t => {
    const f = await fixture(t, { system, machine })
    const result = await f.invoke()
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Unsupported platform/)
    assert.equal(await readFile(f.trace, 'utf8'), '')
  })
}

// Compile a test executable with Windows' built-in PowerShell/.NET Framework; launchers never need it.
test('Windows launcher preserves native I/O, cwd and arguments and verifies its download cache', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-launcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const plugin = join(root, 'marketplace with spaces', 'logic-margin')
  const scripts = join(plugin, 'skills', 'logic-margin', 'scripts')
  await mkdir(scripts, { recursive: true })
  const launcher = join(scripts, 'logic-margin.ps1')
  await copyFile(new URL('logic-margin.ps1', source), launcher)
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ version }))
  const code = `using System; using System.IO; using System.Text;
public class LauncherFixture {
  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine(Environment.GetEnvironmentVariable("FAKE_NATIVE_VERSION")); return 0; }
    Console.WriteLine("native output 中文😀"); Console.Error.WriteLine("native error 中文😀");
    File.WriteAllText(Environment.GetEnvironmentVariable("FAKE_NATIVE_CWD"), Directory.GetCurrentDirectory());
    File.WriteAllBytes(Environment.GetEnvironmentVariable("FAKE_NATIVE_ARGS"), Encoding.UTF8.GetBytes(String.Join("\\0", args) + "\\0"));
    return 37;
  }
}`
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const compiled = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition ${psQuote(code)} -OutputAssembly ${psQuote(join(scripts, 'logic-margin.exe'))} -OutputType ConsoleApplication`])
  assert.equal(compiled.code, 0, compiled.stderr)
  const received = join(root, 'received-args')
  const cwd = join(root, 'project with spaces')
  const cwdRecord = join(root, 'received-cwd')
  await mkdir(cwd)
  const invocation = `Set-Location -LiteralPath ${psQuote(cwd)}; $launcherArguments = @(${cliArgs.map(psQuote).join(', ')}); $output = & ${psQuote(launcher)} @launcherArguments; $code = $LASTEXITCODE; [Console]::Out.WriteLine(($output -join "\n")); exit $code`
  const command = `function Invoke-WebRequest { throw 'Adjacent execution must not download' }; ${invocation}`
  const options = { cwd: root, env: { ...process.env, FAKE_NATIVE_VERSION: version, FAKE_NATIVE_ARGS: received, FAKE_NATIVE_CWD: cwdRecord } }
  const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], options)
  assert.equal(result.code, 37, result.stderr)
  assert.match(result.stdout, /^native output 中文😀\r?\n$/)
  assert.match(result.stderr, /^native error 中文😀\r?\n$/)
  assert.equal(await realpath(await readFile(cwdRecord, 'utf8')), await realpath(cwd))
  assert.deepEqual((await readFile(received, 'utf8')).split('\0'), [...cliArgs, ''])
  const mismatch = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    ...options, env: { ...options.env, FAKE_NATIVE_VERSION: '99.0.0' },
  })
  assert.equal(mismatch.code, 1)
  assert.match(mismatch.stderr, /version 99\.0\.0 does not match plugin/)

  const name = `logic-margin-agent-${version}-win32-x64`
  const staging = join(root, 'archive staging')
  const entry = join(staging, name, 'plugins', 'logic-margin', 'skills', 'logic-margin', 'scripts', 'logic-margin.exe')
  await mkdir(dirname(entry), { recursive: true })
  await copyFile(join(scripts, 'logic-margin.exe'), entry)
  await writeFile(join(staging, 'do-not-extract.txt'), 'must never be extracted')
  const archive = join(root, `${name}.zip`)
  const zipped = await run('zip', ['-qr', archive, '.'], { cwd: staging })
  assert.equal(zipped.code, 0, zipped.stderr)
  const checksum = `${archive}.sha256`
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  await writeFile(checksum, `${digest}  ${name}.zip\n`)
  await rm(join(scripts, 'logic-margin.exe'))
  const localAppData = join(root, 'user local app data')
  const cache = join(localAppData, 'logic-margin', 'native', version, 'win32-x64')
  const sentinel = join(localAppData, 'logic-margin', 'sessions', 'keep.json')
  await mkdir(dirname(sentinel), { recursive: true })
  await writeFile(sentinel, 'existing live review')
  const trace = join(root, 'downloads.log')
  const url = `https://github.com/SunneeYang/LogicMargin/releases/download/v${version}/${name}.zip`
  const download = `function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec, [int]$MaximumRedirection)
    if ($TimeoutSec -ne 120 -or $MaximumRedirection -ne 5) { throw 'Download must have a time/redirect bound' }
    Add-Content -LiteralPath ${psQuote(trace)} -Value $Uri
    if ($Uri -eq ${psQuote(url)}) { Copy-Item -LiteralPath ${psQuote(archive)} -Destination $OutFile }
    elseif ($Uri -eq ${psQuote(`${url}.sha256`)}) { Copy-Item -LiteralPath ${psQuote(checksum)} -Destination $OutFile }
    else { throw 'Unexpected download URL' }
  }; ${invocation}`
  const cachedOptions = { ...options, env: { ...options.env, LOCALAPPDATA: localAppData } }
  const downloaded = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', download], cachedOptions)
  assert.equal(downloaded.code, 37, downloaded.stderr)
  assert.deepEqual((await readFile(received, 'utf8')).split('\0'), [...cliArgs, ''])
  assert.deepEqual(await readdir(cache), ['logic-margin.exe'])
  assert.deepEqual((await readFile(trace, 'utf8')).trim().split(/\r?\n/), [url, `${url}.sha256`])
  const reused = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], cachedOptions)
  assert.equal(reused.code, 37, reused.stderr)
  await rm(join(cache, 'logic-margin.exe'))
  await writeFile(checksum, `${'0'.repeat(64)}  ${name}.zip\n`)
  const rejected = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', download], cachedOptions)
  assert.equal(rejected.code, 1)
  assert.match(rejected.stderr, /SHA-256 mismatch/)
  assert.deepEqual(await readdir(cache), [])
  assert.equal(await readFile(sentinel, 'utf8'), 'existing live review')
})
