import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

interface Owner { pid: number; token: string; file: string }

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function owner(path: string): Promise<Owner | null> {
  try {
    const entries = await readdir(path)
    if (entries.length !== 1) return null
    const match = /^(\d+)\.([a-f0-9-]{36})\.owner$/.exec(entries[0])
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) return null
    return { pid: Number(match[1]), token: match[2], file: entries[0] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function removeStale(path: string): Promise<boolean> {
  const previous = await owner(path)
  if (previous && processAlive(previous.pid)) return false
  try {
    if (!previous && Date.now() - (await stat(path)).mtimeMs < 2000) return false
    if (previous) await unlink(join(path, previous.file)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    await rmdir(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export async function acquireProcessLock(path: string, waitMs = 10000): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  const token = randomUUID()
  const file = `${process.pid}.${token}.owner`
  while (true) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await removeStale(path)) continue
      if (Date.now() >= deadline) throw new Error(`服务锁仍被其他进程占用：${path}`)
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }
    try { await writeFile(join(path, file), '', { mode: 0o600, flag: 'wx' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      await rmdir(path).catch(() => {})
      throw error
    }
    return async () => {
      if ((await owner(path))?.token !== token) return
      await unlink(join(path, file)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error })
    }
  }
}
