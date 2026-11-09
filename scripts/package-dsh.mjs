import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function harnessSkill(source) {
  const start = source.indexOf('## 建立连接\n'), end = source.indexOf('## 发起审查\n')
  if (start < 0 || end <= start) throw new Error('Shared skill connection markers changed; review the DSH projection')
  return source.slice(0, start) + `## 建立连接\n\n此技能由 DeepSeek Harness 插件注册；插件已用官方 MCP Client 接入本机 Go 服务，工具名为 \`mcp__logic_margin__start_review\`、\`mcp__logic_margin__wait_review\` 等。先核对实际工具可用，再发起评审。\n\n服务或工具不可用时读取 [DSH 连接与恢复](references/mcp-workflow.md)，重载此 DSH 插件；需要启动服务时使用本技能 scripts/ 中的固定版本 launcher 执行 \`server start\`。不要运行 Codex 专用 \`server setup\`。安装/更新只按 [DSH 插件安装与更新](references/plugin-updates.md) 执行，不使用网页的 Codex 一键更新。\n\nMCP 与源码工作区必须同机。Tailscale 仅分享网页，不能远程调用读取源码的 MCP。\n\n` + source.slice(end)
}

export async function packageDsh(output = join(root, 'artifacts')) {
  const source = join(root, 'plugins/deepseek-harness')
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const native = JSON.parse(await readFile(join(root, 'plugins/logic-margin/plugin.json'), 'utf8'))
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (manifest.version !== version || native.version !== version) throw new Error('DSH bundle, shared skill and native release versions must match')
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-dsh-package-'))
  try {
    const staging = join(temporary, 'package'), resources = join(staging, 'resources/logic-margin')
    await mkdir(join(resources, 'skills/logic-margin/scripts'), { recursive: true })
    for (const name of ['package.json', 'index.js', 'native.js', 'cordis.patch.yml', 'locale', 'README.md']) await cp(join(source, name), join(staging, name), { recursive: true })
    await cp(join(root, 'src/assets/logo.svg'), join(staging, 'icon.svg'))
    await writeFile(join(resources, 'plugin.json'), JSON.stringify({ name: native.name, version: native.version }, null, 2) + '\n')
    const shared = join(root, 'plugins/logic-margin')
    await cp(join(shared, 'THIRD_PARTY_NOTICES.md'), join(resources, 'THIRD_PARTY_NOTICES.md'))
    for (const name of ['logic-margin.sh', 'logic-margin.ps1']) await cp(join(shared, 'skills/logic-margin/scripts', name), join(resources, 'skills/logic-margin/scripts', name))
    await chmod(join(resources, 'skills/logic-margin/scripts/logic-margin.sh'), 0o755)
    await mkdir(join(resources, 'skills/logic-margin/references'))
    await cp(join(shared, 'skills/logic-margin/references/review-format.md'), join(resources, 'skills/logic-margin/references/review-format.md'))
    for (const name of ['mcp-workflow.md', 'plugin-updates.md']) await cp(join(source, 'references', name), join(resources, 'skills/logic-margin/references', name))
    const skill = await readFile(join(shared, 'skills/logic-margin/SKILL.md'), 'utf8')
    await writeFile(join(resources, 'skills/logic-margin/SKILL.md'), harnessSkill(skill))
    await mkdir(output, { recursive: true })
    const npmCli = basename(process.env.npm_execpath ?? '') === 'npm-cli.js' ? process.env.npm_execpath
      : process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null
    const args = ['pack', '--ignore-scripts', '--json', '--cache', join(temporary, 'npm-cache'), '--pack-destination', resolve(output)]
    const { stdout } = await run(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, { cwd: staging, maxBuffer: 2 * 1024 * 1024 })
    return join(resolve(output), JSON.parse(stdout)[0].filename)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageDsh().then(file => console.log(file)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
