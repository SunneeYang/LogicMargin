import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packageAgent } from './package-agent.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function validateReleaseVersion(tag, versions) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) throw new Error('发布标签须为 vX.Y.Z')
  const version = tag.slice(1)
  for (const [path, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${path} 的版本 ${actual} 与发布标签 ${tag} 不一致`)
  }
  return version
}

export async function releaseAgent(tag, outputDir) {
  const [packageInfo, plugin, lock] = await Promise.all(
    ['package.json', 'plugins/logic-margin/plugin.json', 'package-lock.json'].map(async path => JSON.parse(await readFile(join(root, path), 'utf8'))),
  )
  const version = validateReleaseVersion(tag, {
    'package.json': packageInfo.version,
    'plugins/logic-margin/plugin.json': plugin.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
  })
  const archive = await packageAgent(outputDir)
  const checksum = `${archive}.sha256`
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  await writeFile(checksum, `${digest}  ${basename(archive)}\n`)
  return { tag, version, archive, checksum }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const release = args.length === 1 ? releaseAgent(args[0]) : Promise.reject(new Error('用法：node scripts/release-agent.mjs vX.Y.Z'))
  release.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
