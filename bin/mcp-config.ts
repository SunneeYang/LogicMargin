import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import packageInfo from '../package.json' with { type: 'json' }

const SERVER_NAME = 'logic_margin'
const TOOL_TIMEOUT_SEC = 86400

export interface ConfiguredMcp {
  serverName: string
  url: string
  toolTimeoutSec: number
  reloadRequired: true
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex 配置接口返回了无效响应')
  return value as Record<string, unknown>
}

function endpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('MCP 地址必须是本机 HTTP /mcp 地址') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash) {
    throw new Error('MCP 地址必须是本机 HTTP /mcp 地址')
  }
  return url.toString()
}

export async function configureCodexMcp(mcpUrl: string, options: { command?: string[]; timeoutMs?: number } = {}): Promise<ConfiguredMcp> {
  const url = endpoint(mcpUrl)
  const command = options.command ?? ['codex']
  const timeoutMs = options.timeoutMs ?? 10000
  if (!command.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Codex 配置命令或超时无效')
  const child = spawn(command[0], [...command.slice(1), 'app-server'], {
    cwd: homedir(),
    env: { ...process.env, ...(process.env.CODEX_HOME ? { CODEX_HOME: resolve(process.env.CODEX_HOME) } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; method: string }>()
  let nextId = 0, raw = '', bytes = 0, failure: Error | undefined
  const fail = (error: Error) => {
    failure ??= error
    for (const entry of pending.values()) entry.reject(failure)
    pending.clear()
  }
  const closed = new Promise<void>(resolveClosed => child.once('close', () => {
    fail(new Error('Codex 配置进程提前退出，未确认 MCP 配置；请检查 Codex 安装与配置'))
    resolveClosed()
  }))
  child.once('error', () => fail(new Error('无法启动 Codex 配置进程；请确认 codex 命令可用')))
  child.stdin.on('error', () => fail(new Error('Codex 配置连接已中断，未确认 MCP 配置')))
  child.stderr.resume()
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 4 * 1024 * 1024) { fail(new Error('Codex 配置接口响应超过 4 MB')); child.kill(); return }
    raw += chunk
    let boundary: number
    while ((boundary = raw.indexOf('\n')) >= 0) {
      const line = raw.slice(0, boundary).trim()
      raw = raw.slice(boundary + 1)
      if (!line) continue
      let response: Record<string, unknown>
      try { response = object(JSON.parse(line)) }
      catch { fail(new Error('Codex 配置接口返回了无效 JSON')); child.kill(); return }
      const entry = typeof response.id === 'number' ? pending.get(response.id) : undefined
      if (!entry) continue
      pending.delete(response.id as number)
      if (response.error !== undefined) {
        // Config errors can contain file contents; never echo them or child stderr.
        entry.reject(new Error(`Codex 配置接口 ${entry.method} 不支持或拒绝操作，未确认 MCP 配置`))
      } else if ('result' in response) entry.resolve(response.result)
      else entry.reject(new Error('Codex 配置接口响应缺少结果'))
    }
  })
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure)
    const id = ++nextId
    return new Promise((resolveResult, reject) => {
      pending.set(id, { resolve: resolveResult, reject, method })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  const timer = setTimeout(() => {
    fail(new Error('Codex 配置接口超时，配置结果未确认；请核对后重试'))
    child.kill()
  }, timeoutMs)
  try {
    await request('initialize', { clientInfo: { name: 'logic_margin_setup', version: packageInfo.version } })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const read = object(await request('config/read', { includeLayers: true }))
    const config = object(read.config)
    const servers = config.mcp_servers == null ? {} : object(config.mcp_servers)
    const existing = servers[SERVER_NAME] === undefined ? undefined : object(servers[SERVER_NAME])
    if (existing && (typeof existing.url !== 'string' || endpoint(existing.url) !== url || existing.command !== undefined)) {
      throw new Error('同名 logic_margin MCP 已指向其他服务，原配置已保留；请先核对配置')
    }
    if (existing?.enabled === false) throw new Error('logic_margin MCP 已被禁用，原配置已保留；请先明确启用该服务')
    const configuredTimeout = existing?.tool_timeout_sec
    const toolTimeoutSec = typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > TOOL_TIMEOUT_SEC ? configuredTimeout : TOOL_TIMEOUT_SEC
    if (existing?.url !== url || configuredTimeout !== toolTimeoutSec) {
      const layer = Array.isArray(read.layers) ? read.layers.find(value => {
        const item = object(value), name = object(item.name)
        return name.type === 'user' && name.profile == null
      }) : undefined
      const user = layer === undefined ? undefined : object(layer)
      await request('config/batchWrite', {
        edits: [
          { keyPath: `mcp_servers.${SERVER_NAME}.url`, value: url, mergeStrategy: 'replace' },
          { keyPath: `mcp_servers.${SERVER_NAME}.tool_timeout_sec`, value: toolTimeoutSec, mergeStrategy: 'replace' },
        ],
        ...(typeof user?.version === 'string' ? { expectedVersion: user.version } : {}),
      })
      const checked = object(object(await request('config/read', { includeLayers: false })).config)
      const registered = object(object(checked.mcp_servers)[SERVER_NAME])
      if (registered.url !== url || registered.tool_timeout_sec !== toolTimeoutSec) throw new Error('Codex 未确认预期的 MCP 地址和超时，请核对配置后重试')
    }
    return { serverName: SERVER_NAME, url, toolTimeoutSec, reloadRequired: true }
  } finally {
    clearTimeout(timer)
    child.stdin.end()
    const terminate = setTimeout(() => child.kill('SIGKILL'), 500)
    try { await closed } finally { clearTimeout(terminate) }
  }
}
