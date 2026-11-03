import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'vite'
import { loadUiAssets } from '../server/ui-assets.ts'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = {
  'darwin-arm64': 'bun-darwin-arm64', 'darwin-x64': 'bun-darwin-x64',
  'linux-arm64': 'bun-linux-arm64', 'linux-x64': 'bun-linux-x64', 'win32-x64': 'bun-windows-x64',
}

export async function packageAgent(outputDir = join(root, 'artifacts'), target) {
  if (target !== undefined && !Object.hasOwn(targets, target)) throw new Error(`不支持目标 ${target}；可用目标：${Object.keys(targets).join(', ')}`)
  const plugin = join(root, 'plugins/logic-margin')
  const { version } = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('插件版本须为 x.y.z')
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-package-'))
  try {
    const ui = join(temporary, 'ui')
    await build({ root, configFile: false, publicDir: false, logLevel: 'error', define: { 'import.meta.env.VITE_LOGIC_MARGIN_PACKAGED': JSON.stringify('true') }, build: { outDir: ui } })
    const assets = await loadUiAssets(ui)
    if (!assets['/index.html']) throw new Error('前端构建缺少 index.html')
    const entry = join(temporary, 'runtime-entry.ts')
    const command = target ? '[process.execPath]' : '[process.execPath, fileURLToPath(import.meta.url)]'
    await writeFile(entry, `import { fileURLToPath } from 'node:url'\nimport { runMain } from ${JSON.stringify(join(root, 'bin/main.ts'))}\nrunMain(process.argv.slice(2), { command: ${command}, assets: ${JSON.stringify(assets)} }).catch(error => { console.error('LogicMargin: ' + (error instanceof Error ? error.message : String(error))); process.exitCode = 1 })\n`)
    const executable = target ? target.startsWith('win32-') ? 'logic-margin.exe' : 'logic-margin' : 'logic-margin.mjs'
    const compiled = join(temporary, 'runtime', executable)
    await mkdir(dirname(compiled), { recursive: true })
    if (target) {
      const compileArgs = ['build', '--compile', entry, '--outfile', compiled]
      if (target !== `${process.platform}-${process.arch}`) compileArgs.push(`--target=${targets[target]}`)
      await run('bun', compileArgs)
      if (!target.startsWith('win32-')) await chmod(compiled, 0o755)
    } else {
      await build({ root, configFile: false, publicDir: false, logLevel: 'error', ssr: { noExternal: true }, build: {
        ssr: entry, target: 'node22', outDir: dirname(compiled), minify: true, emptyOutDir: false,
        rolldownOptions: { output: { entryFileNames: executable } },
      } })
      const portable = join(plugin, 'skills/logic-margin/scripts', executable)
      await mkdir(dirname(portable), { recursive: true })
      await cp(compiled, portable)
    }

    const name = `logic-margin-agent-${version}${target ? `-${target}` : ''}`
    const staging = join(temporary, name)
    const stagedPlugin = join(staging, 'plugins/logic-margin')
    await mkdir(join(staging, '.agents/plugins'), { recursive: true })
    await mkdir(join(stagedPlugin, 'skills/logic-margin/scripts'), { recursive: true })
    for (const path of ['plugin.json', 'THIRD_PARTY_NOTICES.md', 'skills/logic-margin/SKILL.md', 'skills/logic-margin/agents', 'skills/logic-margin/references']) {
      await cp(join(plugin, path), join(stagedPlugin, path), { recursive: true })
    }
    await cp(compiled, join(stagedPlugin, 'skills/logic-margin/scripts', executable))
    await cp(join(root, '.agents/plugins/marketplace.json'), join(staging, '.agents/plugins/marketplace.json'))
    await cp(join(root, 'docs/agent-plugin.md'), join(staging, 'README.md'))
    await mkdir(outputDir, { recursive: true })
    const archive = resolve(outputDir, `${name}.zip`)
    const temporaryArchive = join(temporary, `${name}.zip`)
    await run('zip', ['-qr', temporaryArchive, name], { cwd: temporary })
    await cp(temporaryArchive, archive)
    return archive
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const packaging = args.length === 0 ? packageAgent()
    : args.length === 1 && args[0] === '--native' ? packageAgent(undefined, `${process.platform}-${process.arch}`)
    : args.length === 2 && args[0] === '--target' ? packageAgent(undefined, args[1])
    : Promise.reject(new Error('用法：node scripts/package-agent.mjs [--native | --target <platform-arch>]'))
  packaging.then(path => console.log(path)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
