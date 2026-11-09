import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { buildGo, checkTarget, hostTarget, root } from './build-go.mjs'

const run = promisify(execFile)

async function nativeReferences(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await nativeReferences(path); continue }
    if (!entry.name.endsWith('.md')) continue
    let text = await readFile(path, 'utf8')
    text = text.replaceAll('node "$LM_CLI"', '"$LM_CLI"')
      .replaceAll('scripts/logic-margin.mjs', 'scripts/logic-margin')
      .replaceAll('Node.js 22.18+', '匹配当前操作系统与架构的 Go 原生包')
    if (entry.name === 'SKILL.md') {
      const start = text.indexOf('将本技能目录下 ')
      const end = text.indexOf('\n\n```sh', start)
      if (start < 0 || end < 0) throw new Error('原生技能入口模板已变化，请更新打包适配')
      text = text.slice(0, start) + '将本技能目录下 `scripts/logic-margin`（Windows 为 `scripts/logic-margin.exe`）的绝对路径记为 `LM_CLI`，直接运行。PowerShell 用 `&` 调用带空格的路径。用户运行时无需 Node、Bun、Go 或 npm。' + text.slice(end)
    }
    if (entry.name === 'plugin-updates.md') {
      // Candidate binaries are distributed by target ZIP until the migration is accepted.
      text = '# Go 迁移包安装与更新\n\n本包是独立迁移分支的原生发行候选，尚未替换主线 Git marketplace。更新时使用同平台的新 ZIP，校验 SHA-256 后放在持久目录；保留原会话目录，重新注册该目录的 marketplace。不要用主线 marketplace upgrade 将候选包替换回旧 Node 包。正式发布前按迁移文档验收。\n\n首次配置与恢复见 [连接、恢复与 CLI 兼容](mcp-workflow.md)。\n'
    }
    await writeFile(path, text)
  }
}

async function goNotices() {
  const { stdout } = await run('go', ['list', '-m', '-json', 'all'], { cwd: root })
  const modules = JSON.parse('[' + stdout.trim().replace(/}\s*\n\s*{/g, '},{') + ']')
  const dependencies = new Set((await run('go', ['list', '-deps', '-f', '{{if .Module}}{{.Module.Path}}{{end}}', './cmd/logic-margin'], { cwd: root })).stdout.trim().split(/\r?\n/))
  let text = '\n\n# Go backend dependencies\n'
  for (const mod of modules.filter(mod => !mod.Main && dependencies.has(mod.Path))) {
    if (!mod.Dir) throw new Error(`缺少模块许可目录：${mod.Path}`)
    const names = await readdir(mod.Dir)
    const license = names.find(name => /^licen[cs]e(?:\.txt|\.md)?$/i.test(name))
    if (!license) throw new Error(`缺少模块许可：${mod.Path}`)
    text += `\n## ${mod.Path} ${mod.Version}\n\n${await readFile(join(mod.Dir, license), 'utf8')}\n`
  }
  const toolchain = (await run('go', ['env', 'GOROOT'], { cwd: root })).stdout.trim()
  let goLicense
  for (const path of [join(toolchain, 'LICENSE'), join(dirname(toolchain), 'LICENSE')]) {
    try { goLicense = await readFile(path, 'utf8'); break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!goLicense) throw new Error('缺少 Go 标准库与运行时许可')
  text += `\n## Go standard library and runtime\n\n${goLicense}\n`
  return text
}

export async function packageAgent(outputDir = join(root, 'artifacts'), target = hostTarget) {
  checkTarget(target)
  const plugin = join(root, 'plugins/logic-margin')
  const { version } = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'))
  const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (!/^\d+\.\d+\.\d+$/.test(version) || packageVersion !== version) throw new Error('Go 程序与插件版本必须一致')
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-go-package-'))
  try {
    const name = `logic-margin-agent-${version}-${target}`
    const staging = join(temporary, name)
    const stagedPlugin = join(staging, 'plugins/logic-margin')
    const executable = target.startsWith('win32-') ? 'logic-margin.exe' : 'logic-margin'
    const binary = join(stagedPlugin, 'skills/logic-margin/scripts', executable)
    await mkdir(dirname(binary), { recursive: true })
    await buildGo(target, binary)
    if (!target.startsWith('win32-')) await chmod(binary, 0o755)
    for (const path of ['plugin.json', 'THIRD_PARTY_NOTICES.md', 'skills/logic-margin/SKILL.md', 'skills/logic-margin/agents', 'skills/logic-margin/references']) {
      await cp(join(plugin, path), join(stagedPlugin, path), { recursive: true })
    }
    await nativeReferences(join(stagedPlugin, 'skills/logic-margin'))
    const notices = join(stagedPlugin, 'THIRD_PARTY_NOTICES.md')
    await writeFile(notices, await readFile(notices, 'utf8') + await goNotices())
    await mkdir(join(staging, '.agents/plugins'), { recursive: true })
    await cp(join(root, '.agents/plugins/marketplace.json'), join(staging, '.agents/plugins/marketplace.json'))
    await cp(join(root, 'docs/go-agent-plugin.md'), join(staging, 'README.md'))
    await mkdir(outputDir, { recursive: true })
    const archive = resolve(outputDir, `${name}.zip`)
    const candidate = join(temporary, `${name}.zip`)
    await run('zip', ['-qr', candidate, name], { cwd: temporary })
    await cp(candidate, archive)
    await writeFile(`${archive}.sha256`, `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`)
    return archive
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const target = args.length === 0 ? hostTarget : args.length === 2 && args[0] === '--target' ? args[1] : undefined
  const task = target ? packageAgent(undefined, target) : Promise.reject(new Error('用法：node scripts/package-go-agent.mjs [--target <platform-arch>]'))
  task.then(path => console.log(path)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
