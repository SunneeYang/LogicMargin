import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateReleaseVersion } from './release-agent.mjs'

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

test('release CLI rejects a mismatched tag before changing the packaged runtime', async () => {
  const runtime = new URL('../plugins/logic-margin/skills/logic-margin/scripts/logic-margin.mjs', import.meta.url)
  const original = await readFile(runtime)
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./release-agent.mjs', import.meta.url)), 'v999999.0.0']), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /与发布标签.*不一致/)
    assert.equal(error.stdout, '')
    return true
  })
  assert.deepEqual(await readFile(runtime), original)
})
