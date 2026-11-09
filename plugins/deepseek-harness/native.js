import { execFile, spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function settleStartup(child, closed) {
  const signal = kind => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind)
      else child.kill(kind)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const wait = async () => {
    let timer
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000) })]) }
    finally { clearTimeout(timer) }
  }
  signal('SIGTERM')
  const exited = await wait()
  if (process.platform === 'win32' && child.pid) {
    if (!exited) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 1000, windowsHide: true }).catch(() => {})
  } else signal('SIGKILL')
  if (!await wait()) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  }
}

export function launcherCommand(resources, platform = process.platform) {
  const scripts = join(resources, 'skills/logic-margin/scripts')
  if (platform === 'win32') return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'logic-margin.ps1')]]
  if (platform === 'darwin' || platform === 'linux') return ['/bin/sh', [join(scripts, 'logic-margin.sh')]]
  throw new Error(`Unsupported LogicMargin platform: ${platform}`)
}

export function validateServer(value) {
  if (!value || value.managed !== true || typeof value.url !== 'string' || typeof value.mcpUrl !== 'string') throw new Error('LogicMargin startup did not confirm a managed local service')
  let url, base
  try { url = new URL(value.mcpUrl); base = new URL(value.url) } catch { throw new Error('LogicMargin returned an invalid MCP URL') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash
    || base.origin !== url.origin || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('LogicMargin MCP must use a local HTTP endpoint')
  return { url: url.origin, mcpUrl: url.href }
}

export async function startNativeServer(resources, config, signal, parentEnv) {
  signal.throwIfAborted()
  if (config.home !== undefined && (typeof config.home !== 'string' || !isAbsolute(config.home))) throw new Error('LogicMargin home must be an absolute path')
  if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) throw new Error('LogicMargin port must be an integer from 0 to 65535')
  const [command, args] = launcherCommand(resources)
  const env = { ...parentEnv }
  if (config.home !== undefined) env.LOGIC_MARGIN_HOME = config.home
  let stdout
  // execFile does not forward detached; spawn gives the launcher its own POSIX process group.
  const child = spawn(command, [...args, 'server', 'start', ...(config.port === undefined ? [] : ['--port', String(config.port)])], {
    cwd: resources, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let didClose = false
  const closed = new Promise(resolve => child.once('close', () => { didClose = true; resolve() }))
  let timer, abort
  try {
    stdout = await new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      child.stdout.on('data', chunk => {
        size += chunk.length
        if (size > 1024 * 1024) reject(new Error('LogicMargin startup output exceeded its limit'))
        else chunks.push(chunk)
      })
      child.stderr.resume()
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('LogicMargin startup exited unsuccessfully')))
      timer = setTimeout(() => reject(new Error('LogicMargin startup timed out')), 300_000)
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } catch {
    if (!didClose) await settleStartup(child, closed)
    if (signal.aborted) throw signal.reason
    throw new Error('LogicMargin native startup failed; run the packaged launcher with "server status" to diagnose. No Codex configuration was changed.')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
  let value
  try { value = JSON.parse(stdout) } catch { throw new Error('LogicMargin startup returned invalid JSON') }
  return validateServer(value)
}
