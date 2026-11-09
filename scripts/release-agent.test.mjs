import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { releaseAgent, validateReleaseVersion, verifyReleaseArtifacts } from './release-agent.mjs'
import { checkTarget, targets } from './build-go.mjs'
import { packageDsh } from './package-dsh.mjs'

const version = JSON.parse(await readFile(new URL('../plugins/logic-margin/plugin.json', import.meta.url), 'utf8')).version
const tag = `v${version}`
const releaseTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
const dshName = `dsh-plugin-logicmargin-${version}.tgz`
const run = promisify(execFile)

async function releaseFixture(t) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-release-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const target of releaseTargets) {
    const name = `logic-margin-agent-${version}-${target}.zip`
    const contents = Buffer.from(`fixture ${target}`)
    const line = `${createHash('sha256').update(contents).digest('hex')}  ${name}\n`
    await writeFile(join(directory, name), contents)
    await writeFile(join(directory, `${name}.sha256`), line)
  }
  await packageDsh(directory)
  return { directory }
}

test('release tag must be a stable version matching every version manifest', () => {
  const versions = { package: '1.2.3', plugin: '1.2.3', lock: '1.2.3', lockRoot: '1.2.3' }
  assert.equal(validateReleaseVersion('v1.2.3', versions), '1.2.3')
  for (const tag of [undefined, '', '1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-beta.1', 'v1.2.3/other']) {
    assert.throws(() => validateReleaseVersion(tag, versions), /发布标签须为/)
  }
  for (const key of Object.keys(versions)) {
    assert.throws(() => validateReleaseVersion('v1.2.3', { ...versions, [key]: '1.2.2' }), new RegExp(`${key}.*不一致`))
    assert.throws(() => validateReleaseVersion('v1.2.3', { ...versions, [key]: undefined }), new RegExp(`${key}.*不一致`))
  }
})

test('release targets are exactly the five native platforms', () => {
  assert.deepEqual(Object.keys(targets).sort(), releaseTargets)
  for (const target of releaseTargets) assert.doesNotThrow(() => checkTarget(target))
  for (const target of [undefined, 'linux', 'windows-x64', 'win32-arm64', '../linux-x64']) {
    assert.throws(() => checkTarget(target), /不支持目标/)
  }
})

test('release creates SHA256SUMS only after five ZIPs and the DSH bundle are verified', async t => {
  const { directory } = await releaseFixture(t)
  const result = await verifyReleaseArtifacts(tag, directory)
  assert.equal(result.tag, tag)
  assert.equal(result.version, version)
  assert.deepEqual(result.archives.map(path => basename(path)), [...releaseTargets.map(target => `logic-margin-agent-${version}-${target}.zip`), dshName].sort())
  assert.deepEqual(result.checksums, result.archives.map(path => `${path}.sha256`))
  assert.equal(result.checksumManifest, join(directory, 'SHA256SUMS'))
  assert.equal(await readFile(result.checksumManifest, 'utf8'), (await Promise.all(result.checksums.map(path => readFile(path, 'utf8')))).join(''))
})

test('release rejects missing, extra and stale-version artifacts', async t => {
  for (const scenario of ['missing ZIP', 'missing checksum', 'missing DSH', 'missing DSH checksum', 'extra target', 'stale version', 'stale DSH']) {
    await t.test(scenario, async t => {
      const { directory } = await releaseFixture(t)
      const name = `logic-margin-agent-${version}-linux-x64.zip`
      if (scenario === 'missing ZIP') await rm(join(directory, name))
      if (scenario === 'missing checksum') await rm(join(directory, `${name}.sha256`))
      if (scenario === 'missing DSH') await rm(join(directory, dshName))
      if (scenario === 'missing DSH checksum') await rm(join(directory, `${dshName}.sha256`))
      if (scenario === 'extra target') await writeFile(join(directory, `logic-margin-agent-${version}-win32-arm64.zip`), '')
      if (scenario === 'stale version') await writeFile(join(directory, 'logic-margin-agent-0.0.0-linux-x64.zip'), '')
      if (scenario === 'stale DSH') await writeFile(join(directory, 'dsh-plugin-logicmargin-0.0.0.tgz'), '')
      await assert.rejects(verifyReleaseArtifacts(tag, directory), /必须恰好包含五个目标/)
      assert.equal((await readdir(directory)).includes('SHA256SUMS'), false)
    })
  }
})

test('release rejects renamed stale DSH packages and invalid MIT metadata even with valid checksums', async t => {
  for (const scenario of ['package version', 'launcher version', 'license metadata', 'license text', 'bundle path']) {
    await t.test(scenario, async t => {
      const { directory } = await releaseFixture(t)
      const unpacked = join(directory, 'unpacked')
      await mkdir(unpacked)
      const archive = join(directory, dshName)
      await run('tar', ['-xzf', archive, '-C', unpacked])
      const path = join(unpacked, 'package', scenario === 'launcher version' ? 'resources/logic-margin/plugin.json' : 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      if (scenario === 'package version' || scenario === 'launcher version') manifest.version = '0.0.0'
      if (scenario === 'license metadata') manifest.license = 'UNLICENSED'
      if (scenario === 'bundle path') manifest.dsh.bundle.patch = './missing.yml'
      await writeFile(path, JSON.stringify(manifest))
      if (scenario === 'license text') await writeFile(join(unpacked, 'package/LICENSE'), 'wrong license')
      await run('tar', ['-czf', archive, '-C', unpacked, 'package'])
      await writeFile(`${archive}.sha256`, `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${dshName}\n`)
      await assert.rejects(verifyReleaseArtifacts(tag, directory), /不一致/)
      assert.equal((await readdir(directory)).includes('SHA256SUMS'), false)
    })
  }
})

test('release rejects corrupted ZIPs and checksums naming another artifact', async t => {
  for (const corruptArchive of [true, false]) {
    const { directory } = await releaseFixture(t)
    const name = `logic-margin-agent-${version}-linux-x64.zip`
    if (corruptArchive) await writeFile(join(directory, name), 'corrupt ZIP')
    else await writeFile(join(directory, `${name}.sha256`), `${'0'.repeat(64)}  another.zip\n`)
    await assert.rejects(verifyReleaseArtifacts(tag, directory), /SHA-256 校验失败/)
    assert.equal((await readdir(directory)).includes('SHA256SUMS'), false)
  }
})

test('release rejects a mismatched tag before creating output or changing plugin inputs', async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-release-version-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'artifacts')
  await assert.rejects(releaseAgent('v999999.0.0', output), /与发布标签.*不一致/)
  await assert.rejects(readdir(output), { code: 'ENOENT' })
  const skill = new URL('../plugins/logic-margin/skills/logic-margin/SKILL.md', import.meta.url)
  const original = await readFile(skill)
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./release-agent.mjs', import.meta.url)), 'v999999.0.0']), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /与发布标签.*不一致/)
    assert.equal(error.stdout, '')
    return true
  })
  assert.deepEqual(await readFile(skill), original)
})
