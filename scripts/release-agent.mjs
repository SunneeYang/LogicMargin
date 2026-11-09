import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { packageAgent } from './package-go-agent.mjs'
import { packageDsh } from './package-dsh.mjs'
import { targets } from './build-go.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)

export function validateReleaseVersion(tag, versions) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) throw new Error('发布标签须为 vX.Y.Z')
  const version = tag.slice(1)
  for (const [path, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${path} 的版本 ${actual} 与发布标签 ${tag} 不一致`)
  }
  return version
}

async function releaseVersion(tag) {
  const [packageInfo, plugin, lock, dsh] = await Promise.all(
    ['package.json', 'plugins/logic-margin/plugin.json', 'package-lock.json', 'plugins/deepseek-harness/package.json'].map(async path => JSON.parse(await readFile(join(root, path), 'utf8'))),
  )
  return validateReleaseVersion(tag, {
    'package.json': packageInfo.version,
    'plugins/logic-margin/plugin.json': plugin.version,
    'plugins/deepseek-harness/package.json': dsh.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
  })
}

export async function verifyReleaseArtifacts(tag, outputDir = join(root, 'artifacts')) {
  const version = await releaseVersion(tag)
  const dshName = `dsh-plugin-logicmargin-${version}.tgz`
  const names = [...Object.keys(targets).map(target => `logic-margin-agent-${version}-${target}.zip`), dshName].sort()
  const expected = names.flatMap(name => [name, `${name}.sha256`]).sort()
  const actual = (await readdir(outputDir)).filter(name => /\.(?:zip|tgz|sha256)$/.test(name)).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('发布产物必须恰好包含五个目标 ZIP、一个 DSH tgz 及各自的 SHA-256 校验文件')
  let sums = ''
  for (const name of names) {
    const digest = createHash('sha256').update(await readFile(join(outputDir, name))).digest('hex')
    const line = `${digest}  ${name}\n`
    if (await readFile(join(outputDir, `${name}.sha256`), 'utf8') !== line) throw new Error(`${name} 的 SHA-256 校验失败`)
    sums += line
  }
  const entry = async path => (await run('tar', ['-xOf', join(outputDir, dshName), `package/${path}`], { maxBuffer: 1024 * 1024 })).stdout
  const [dsh, native, license] = await Promise.all([entry('package.json').then(JSON.parse), entry('resources/logic-margin/plugin.json').then(JSON.parse), entry('LICENSE')])
  validateReleaseVersion(tag, { 'DSH tgz': dsh.version, 'DSH native launcher': native.version })
  if (dsh.name !== 'dsh-plugin-logicmargin' || dsh.license !== 'MIT' || dsh.dsh?.bundle?.patch !== './cordis.patch.yml'
    || license !== await readFile(join(root, 'LICENSE'), 'utf8')) throw new Error('DSH tgz 的包身份、bundle 入口或 MIT 许可不一致')
  const checksumManifest = join(outputDir, 'SHA256SUMS')
  await writeFile(checksumManifest, sums)
  return { tag, version, archives: names.map(name => join(outputDir, name)), checksums: names.map(name => join(outputDir, `${name}.sha256`)), checksumManifest }
}

export async function releaseAgent(tag, outputDir = join(root, 'artifacts')) {
  await releaseVersion(tag)
  // Each build writes shared embedded assets; keep target builds sequential.
  for (const target of Object.keys(targets)) await packageAgent(outputDir, target)
  await packageDsh(outputDir)
  return verifyReleaseArtifacts(tag, outputDir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const release = args.length === 1 ? releaseAgent(args[0])
    : args.length === 2 && args[1] === '--verify' ? verifyReleaseArtifacts(args[0])
    : Promise.reject(new Error('用法：node scripts/release-agent.mjs vX.Y.Z [--verify]'))
  release.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
