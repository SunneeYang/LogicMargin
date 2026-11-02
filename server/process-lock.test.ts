import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireProcessLock } from './process-lock.ts'

test('locks retain live owners and reclaim only a dead owner nonce', async t => {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'process.lock')
  const release = await acquireProcessLock(path, 0)
  const original = await readdir(path)
  await assert.rejects(acquireProcessLock(path, 0), /仍被其他进程占用/)
  assert.deepEqual(await readdir(path), original)
  await release()
  await mkdir(path)
  const stale = `2147483647.${randomUUID()}.owner`
  await writeFile(join(path, stale), '')
  const recovered = await acquireProcessLock(path, 0)
  assert.notDeepEqual(await readdir(path), [stale])
  await recovered()
  await mkdir(path)
  await writeFile(join(path, 'unrecognized-data'), 'preserve')
  await assert.rejects(acquireProcessLock(path, 0), /仍被其他进程占用/)
  assert.equal(await readFile(join(path, 'unrecognized-data'), 'utf8'), 'preserve')
})
