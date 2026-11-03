import { fileURLToPath } from 'node:url'
import { runCli } from './logic-margin.ts'
import { ensureService, getServiceStatus, runDaemon, runtimeVersion, stopService } from '../server/daemon.ts'
import { loadUiAssets } from '../server/ui-assets.ts'
import type { EmbeddedAssets } from '../server/runtime.ts'
import { configureCodexMcp } from './mcp-config.ts'

interface Runtime { command: string[]; assets: EmbeddedAssets }
function flags(args: string[], allowed: string[]) {
  const values: Record<string, string> = {}
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at]
    const value = args[at + 1]
    if (!allowed.includes(name) || value === undefined || name in values) throw new Error(`无效或重复的服务参数：${name}`)
    values[name] = value
  }
  return values
}
function port(value?: string) {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0 || number > 65535) throw new Error('端口须为 0–65535 的整数')
  return number
}

export async function runMain(args: string[], runtime?: Runtime) {
  const command = runtime?.command ?? [process.execPath, fileURLToPath(new URL('./entry.ts', import.meta.url))]
  if (args[0] === '_serve') {
    const values = flags(args.slice(1), ['--home', '--host', '--port', '--instance-id', '--shutdown-token', '--data-dir'])
    if (!values['--instance-id'] || !values['--shutdown-token']) throw new Error('后台服务缺少实例凭据')
    const assets = runtime?.assets ?? await loadUiAssets(fileURLToPath(new URL('../dist/', import.meta.url)))
    await runDaemon({ assets, home: values['--home'], host: values['--host'], port: port(values['--port']), dataDir: values['--data-dir'], instanceId: values['--instance-id'], shutdownToken: values['--shutdown-token'], version: runtimeVersion })
    return
  }
  if (args[0] === 'server') {
    const action = args[1]
    if (!['start', 'setup', 'status', 'stop'].includes(action)) throw new Error('用法：server start/setup [--host HOST] [--port PORT] | server status | server stop')
    const values = flags(args.slice(2), ['start', 'setup'].includes(action) ? ['--host', '--port'] : [])
    let result: unknown
    if (action === 'start' || action === 'setup') {
      const service = await ensureService({ command, host: values['--host'], port: port(values['--port']), requireMcp: true })
      const mcpUrl = `${service.url}/mcp`
      result = { ...service, mcpUrl, ...(action === 'setup' ? { mcp: await configureCodexMcp(mcpUrl) } : {}) }
    } else result = action === 'status' ? await getServiceStatus() : { stopped: await stopService() }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    await runCli(['--help'])
    process.stdout.write('\n  server start [--host HOST] [--port PORT]\n  server setup [--host HOST] [--port PORT]  (register HTTP MCP in this Codex home)\n  server status\n  server stop\n\nOne daemon serves HTTP MCP, review API and embedded UI. CLI commands exit when complete.\n')
    return
  }
  await runCli(args, undefined, command)
}
