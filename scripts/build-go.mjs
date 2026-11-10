import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import { buildGraphPrecompute } from './build-graph-precompute.mjs'
import { buildStructureParser } from './build-structure-parser.mjs'

const run = promisify(execFile)
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const targets = {
  'darwin-arm64': ['darwin', 'arm64'], 'darwin-x64': ['darwin', 'amd64'],
  'linux-arm64': ['linux', 'arm64'], 'linux-x64': ['linux', 'amd64'], 'win32-x64': ['windows', 'amd64'],
}
export const hostTarget = `${process.platform}-${process.arch}`

export function checkTarget(target) {
  if (!Object.hasOwn(targets, target)) throw new Error(`不支持目标 ${target}；可用目标：${Object.keys(targets).join(', ')}`)
}

export async function buildUi() {
  const destination = join(root, 'internal/ui/dist')
  await mkdir(destination, { recursive: true })
  for (const name of await readdir(destination)) {
    if (name !== '.placeholder') await rm(join(destination, name), { recursive: true, force: true })
  }
  await build({ root, configFile: false, publicDir: false, logLevel: 'error',
    define: { 'import.meta.env.VITE_LOGIC_MARGIN_PACKAGED': JSON.stringify('true') },
    build: { outDir: destination, emptyOutDir: false },
  })
  await readFile(join(destination, 'index.html'))
}

export async function buildGo(target = hostTarget, output, { uiReady = false, signal } = {}) {
  checkTarget(target)
  signal?.throwIfAborted()
  if (!uiReady) await buildUi()
  signal?.throwIfAborted()
  await buildGraphPrecompute()
  signal?.throwIfAborted()
  await buildStructureParser()
  signal?.throwIfAborted()
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('程序版本须为 x.y.z')
  output = resolve(output ?? join(root, 'artifacts/go', target, target.startsWith('win32-') ? 'logic-margin.exe' : 'logic-margin'))
  await mkdir(dirname(output), { recursive: true })
  const [GOOS, GOARCH] = targets[target]
  await run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', output, './cmd/logic-margin'],
    { cwd: root, signal, env: { ...process.env, CGO_ENABLED: '0', GOOS, GOARCH }, maxBuffer: 8 * 1024 * 1024 })
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const target = args.length === 0 ? hostTarget : args.length === 2 && args[0] === '--target' ? args[1] : undefined
  const task = target ? buildGo(target) : Promise.reject(new Error('用法：node scripts/build-go.mjs [--target <platform-arch>]'))
  task.then(path => console.log(path)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
