import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireProcessLock } from './process-lock.ts'

test('lock creation handles Windows delete-pending EPERM within its existing deadline', async t => {
  for (const scenario of [
    { platform: 'win32', code: 'EPERM', transient: true, wait: 500, succeeds: true },
    { platform: 'win32', code: 'EPERM', transient: false, wait: 20, succeeds: false },
    { platform: 'win32', code: 'EPERM', transient: false, wait: 0, succeeds: false },
    { platform: 'linux', code: 'EPERM', transient: true, wait: 500, succeeds: false },
    { platform: 'win32', code: 'EACCES', transient: true, wait: 500, succeeds: false },
  ]) {
    await t.test(`${scenario.platform}/${scenario.code}/${scenario.transient}/${scenario.wait}`, { timeout: 5000 }, async t => {
      const directory = await fs.mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-lock-retry-'))
      t.after(() => fs.rm(directory, { recursive: true, force: true }))
      const path = join(directory, 'start.lock')
      const marker = join(path, `${process.pid}.${randomUUID()}.owner`)
      if (!scenario.succeeds) {
        await fs.mkdir(path)
        await fs.writeFile(marker, 'preserve live owner')
      }
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
      const realMkdir = fs.mkdir
      const failure = Object.assign(new Error('injected mkdir error'), { code: scenario.code, syscall: 'mkdir', path })
      let attempts = 0
      try {
        Object.defineProperty(process, 'platform', { value: scenario.platform })
        t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof realMkdir>) => {
          if (args[0] === path && (++attempts === 1 || !scenario.transient)) throw failure
          return realMkdir(...args)
        })
        syncBuiltinESMExports()
        if (scenario.succeeds) {
          const release = await acquireProcessLock(path, scenario.wait)
          assert.equal(attempts, 2)
          await release()
          await assert.rejects(fs.stat(path), { code: 'ENOENT' })
        } else {
          await assert.rejects(acquireProcessLock(path, scenario.wait), error => error === failure)
          assert.equal(await fs.readFile(marker, 'utf8'), 'preserve live owner')
          assert.equal(attempts > 1, scenario.platform === 'win32' && scenario.code === 'EPERM' && scenario.wait > 0)
        }
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    })
  }
})
