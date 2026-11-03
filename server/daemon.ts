import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import packageInfo from '../package.json' with { type: 'json' }
import { createReviewServer } from './runtime.ts'
import type { EmbeddedAssets } from './runtime.ts'
import { acquireProcessLock, processAlive } from './process-lock.ts'

export const runtimeVersion = packageInfo.version
interface Registry { pid: number; url: string; host: string; instanceId: string; shutdownToken: string; version: string; startedAt: string; dataDir?: string }
interface Health { service: string; apiVersion: number; version: string; instanceId: string; pid: number; managed: boolean; mcp?: boolean }
interface Location { home?: string }
interface ServiceOptions extends Location { url?: string; command?: string[]; host?: string; port?: number; dataDir?: string; requireMcp?: boolean }
export interface ServiceStatus { running: boolean; managed: boolean; url?: string; host?: string; pid?: number; version?: string; reason?: string; processRunning?: boolean; compatible?: boolean; mcpUrl?: string }

function homePath(options: Location) { return resolve(options.home ?? process.env.LOGIC_MARGIN_HOME ?? join(homedir(), '.logic-margin')) }
function registryPath(home: string) { return join(home, 'daemon.json') }
function validUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' }
  catch { return false }
}
async function registry(home: string): Promise<Registry | null> {
  let raw: string
  try { raw = await readFile(registryPath(home), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const value = JSON.parse(raw) as Registry
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !validUrl(value.url) || typeof value.host !== 'string' || !value.host || typeof value.instanceId !== 'string' || !value.instanceId ||
      typeof value.shutdownToken !== 'string' || !value.shutdownToken || typeof value.version !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
      (value.dataDir !== undefined && (typeof value.dataDir !== 'string' || !value.dataDir))) throw new Error('字段无效')
    return value
  } catch { throw new Error(`后台服务记录损坏，原文件已保留：${registryPath(home)}`) }
}
async function health(url: string): Promise<Health | null> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return null
    const value = await response.json() as Health
    return value.service === 'logic-margin' && value.apiVersion === 1 && typeof value.version === 'string' && typeof value.instanceId === 'string' &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.managed === 'boolean' ? value : null
  } catch { return null }
}
function sameInstance(entry: Registry, value: Health | null): value is Health { return !!value && value.managed && value.pid === entry.pid && value.instanceId === entry.instanceId }
function compatible(value: Health) {
  if (value.version !== runtimeVersion) throw new Error(`已运行 LogicMargin ${value.version}，当前程序为 ${runtimeVersion}；请先停止旧服务后重试`)
}
async function registeredStatus(home: string): Promise<{ entry: Registry | null; value: Health | null }> {
  const entry = await registry(home)
  return { entry, value: entry ? await health(entry.url) : null }
}

export async function getServiceStatus(options: Location = {}): Promise<ServiceStatus> {
  const { entry, value } = await registeredStatus(homePath(options))
  if (!entry) return { running: false, managed: false }
  if (!sameInstance(entry, value)) return { running: false, managed: true, url: entry.url, pid: entry.pid, version: entry.version,
    processRunning: processAlive(entry.pid), reason: value ? '健康接口与登记实例身份不匹配，未接管该进程' : '登记的后台实例不可达，请核对进程状态与 daemon.log' }
  return { running: true, managed: true, url: entry.url, host: entry.host, pid: value.pid, version: value.version,
    processRunning: true, compatible: value.version === runtimeVersion, ...(value.mcp === true ? { mcpUrl: `${entry.url}/mcp` } : {}) }
}

async function spawnDaemon(command: string[], home: string, options: ServiceOptions): Promise<{ url: string; managed: boolean }> {
  const instanceId = randomUUID(), shutdownToken = randomUUID()
  const args = [...command.slice(1), '_serve', '--home', home, '--host', options.host ?? '127.0.0.1', '--port', String(options.port ?? 0), '--instance-id', instanceId, '--shutdown-token', shutdownToken]
  if (options.dataDir) args.push('--data-dir', options.dataDir)
  const log = openSync(join(home, 'daemon.log'), 'a', 0o600)
  const child = spawn(command[0], args, { detached: true, stdio: ['ignore', 'pipe', log], windowsHide: true })
  closeSync(log)
  try {
    const result = await new Promise<{ url: string; managed: boolean }>((resolveReady, reject) => {
      let raw = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('LogicMargin 后台服务未在 10 秒内启动，请查看 daemon.log')) }, 10000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      child.once('error', fail)
      child.once('exit', (code, signal) => fail(new Error(`LogicMargin 后台服务提前退出（${code ?? signal}），请查看 ${join(home, 'daemon.log')}`)))
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        raw += chunk
        if (raw.length > 8192) { child.kill(); fail(new Error('后台服务启动响应过大')); return }
        if (!raw.includes('\n')) return
        try {
          const ready = JSON.parse(raw.split('\n')[0]) as { url?: unknown; instanceId?: unknown; pid?: unknown }
          if (!validUrl(ready.url) || ready.instanceId !== instanceId || ready.pid !== child.pid) throw new Error('后台服务启动响应无效')
          clearTimeout(timer); child.removeListener('error', fail)
          resolveReady({ url: ready.url, managed: true })
        } catch (error) { child.kill(); fail(error instanceof Error ? error : new Error(String(error))) }
      })
    })
    const value = await health(result.url)
    if (!value || value.instanceId !== instanceId || value.pid !== child.pid) { child.kill(); throw new Error('后台服务启动后健康检查失败') }
    compatible(value)
    return result
  } finally { child.stdout?.destroy(); child.unref() }
}

export async function ensureService(options: ServiceOptions = {}): Promise<{ url: string; managed: boolean }> {
  if (options.url !== undefined) return { url: options.url, managed: false }
  const home = homePath(options)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const release = await acquireProcessLock(join(home, 'start.lock'))
  try {
    const { entry, value } = await registeredStatus(home)
    if (entry && sameInstance(entry, value)) {
      compatible(value)
      if (options.requireMcp && value.mcp !== true) throw new Error('已登记服务尚未提供 MCP，请先 server stop 后用当前程序重启')
      if ((options.host && options.host !== entry.host) || (options.port && options.port !== Number(new URL(entry.url).port))) throw new Error('已运行服务的监听地址不同，请先 server stop 再按新地址启动')
      return { url: entry.url, managed: true }
    }
    if (entry && processAlive(entry.pid)) throw new Error('已登记服务进程仍在运行但健康检查失败，未启动第二个写入进程；请先检查 server status 与 daemon.log')
    if (!options.requireMcp && !options.home && !process.env.LOGIC_MARGIN_HOME && !options.host && options.port === undefined) {
      const existing = await health('http://127.0.0.1:5173')
      if (existing) { compatible(existing); return { url: 'http://127.0.0.1:5173', managed: false } }
    }
    if (!options.command?.length) throw new Error('缺少后台服务启动命令；请使用完整安装包，或显式指定 --url')
    return await spawnDaemon(options.command, home, { ...options, host: options.host ?? entry?.host,
      port: options.port ?? (entry ? Number(new URL(entry.url).port) : undefined),
      dataDir: options.dataDir ?? process.env.LOGIC_MARGIN_DATA_DIR ?? entry?.dataDir })
  } finally { await release() }
}

export async function stopService(options: Location = {}): Promise<boolean> {
  const home = homePath(options)
  const release = await acquireProcessLock(join(home, 'start.lock'))
  try {
    const { entry, value } = await registeredStatus(home)
    if (!entry) return false
    if (!sameInstance(entry, value)) {
      if (processAlive(entry.pid)) throw new Error('后台实例身份或健康状态不匹配，未关闭该进程')
      return false
    }
    const response = await fetch(`${entry.url}/api/shutdown`, { method: 'POST', headers: { 'x-logic-margin-token': entry.shutdownToken }, signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error(`后台服务拒绝停止：HTTP ${response.status}`)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!sameInstance(entry, await health(entry.url)) && !processAlive(entry.pid)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('后台服务未在 5 秒内停止，会话数据已保留')
  } finally { await release() }
}

export async function runDaemon(options: Location & { assets: EmbeddedAssets; host?: string; port?: number; dataDir?: string; instanceId: string; shutdownToken: string; version: string }): Promise<void> {
  const home = homePath(options)
  const dataDir = resolve(options.dataDir ?? process.env.LOGIC_MARGIN_DATA_DIR ?? join(home, 'sessions'))
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const release = await acquireProcessLock(join(dataDir, '.service-lock'), 0)
  let close: (() => Promise<void>) | undefined
  // Keep the last endpoint so a restart preserves the browser origin and its unsent drafts.
  const cleanup = release
  const signal = () => { void close?.().catch(error => { console.error(error); process.exitCode = 1 }) }
  try {
    const server = await createReviewServer({ assets: options.assets, dataDir, host: options.host, port: options.port, instanceId: options.instanceId, version: options.version, shutdownToken: options.shutdownToken })
    close = server.close
    await mkdir(home, { recursive: true, mode: 0o700 })
    const entry: Registry = { pid: process.pid, url: server.url, host: options.host ?? '127.0.0.1', instanceId: options.instanceId, shutdownToken: options.shutdownToken, version: options.version, startedAt: new Date().toISOString(), dataDir }
    const temporary = `${registryPath(home)}.${options.instanceId}.tmp`
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' })
    await rename(temporary, registryPath(home))
    process.once('SIGTERM', signal); process.once('SIGINT', signal)
    process.stdout.write(`${JSON.stringify({ url: server.url, instanceId: options.instanceId, pid: process.pid })}\n`)
    await server.closed
  } finally {
    process.off('SIGTERM', signal); process.off('SIGINT', signal)
    try { await close?.() } finally { await cleanup() }
  }
}
