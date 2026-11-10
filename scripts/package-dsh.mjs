import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  return source.slice(0, start) + `## 建立连接\n\n此技能由 DeepSeek Harness 插件注册；插件使用官方 MCP Client 接入本机 Go 服务，工具名为 \`mcp__logic_margin__start_review\`、\`mcp__logic_margin__wait_review\` 等。先从本技能 scripts/ 定位固定版本 launcher，记为 \`LM_CLI\`，通过宿主终端运行 \`server status\` 核对身份、版本和原端口，再实际调用只读 \`mcp__logic_margin__list_reviews\`（优先已知 context）。成功返回才确认当前 MCP 链路可用，工具名字或 HTTP 健康不足以证明握手成功。\n\n握手或工具装载失败时，按 [DSH 连接与恢复](references/mcp-workflow.md) 区分启动器/制品、HTTP 服务和宿主连接，重载插件尝试一次；后台健康兼容而 MCP 仍不可用，就在原任务授权内用原生 CLI 回退，等待使用 \`wait SESSION_ID --no-consume\`，实际读完反馈后再领取。保留同一 session 和已处理游标，说明宿主长等待限制。\n\n服务不存在时按参考安全执行 \`server start\`。不要运行 Codex 专用 \`server setup\`。安装/更新按 [DSH 插件安装与更新](references/plugin-updates.md) 执行，不使用网页的 Codex 一键更新。MCP 与源码工作区同机；网页共享仍先按前节确认访问范围，MCP 保持本机边界。\n\n` + source.slice(end)
}

export async function packageDsh(output = join(root, 'artifacts')) {
  const source = join(root, 'plugins/deepseek-harness')
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const native = JSON.parse(await readFile(join(root, 'plugins/logic-margin/plugin.json'), 'utf8'))
  const { version, license } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.version !== version || native.version !== version) throw new Error('DSH bundle, shared skill and native release versions must match')
  if (manifest.license !== license || license !== 'MIT') throw new Error('DSH bundle must use the project MIT license')
  const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-dsh-package-'))
  try {
    const staging = join(temporary, 'package'), resources = join(staging, 'resources/logic-margin')
    await mkdir(join(resources, 'skills/logic-margin/scripts'), { recursive: true })
    for (const name of ['package.json', 'index.js', 'native.js', 'cordis.patch.yml', 'locale', 'README.md']) await cp(join(source, name), join(staging, name), { recursive: true })
    await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'))
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
    const archive = join(resolve(output), JSON.parse(stdout)[0].filename)
    await writeFile(`${archive}.sha256`, `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`)
    return archive
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageDsh().then(file => console.log(file)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
