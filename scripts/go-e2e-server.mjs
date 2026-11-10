import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGo, root } from './build-go.mjs'
import { createServer } from 'vite'
import { startGo } from './go-process.mjs'

const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-e2e-'))
const controller = new AbortController()
let service, vite
const stop = async () => { controller.abort(); await vite?.close(); await service?.stop() }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
try {
  const binary = await buildGo(undefined, undefined, { signal: controller.signal })
  service = await startGo({ binary, dataDir: join(temporary, 'sessions'), port: 4173, signal: controller.signal })
  controller.signal.throwIfAborted()
  // Source-only example tests retain Vite's public assets; API/MCP still use this Go process.
  process.env.LOGIC_MARGIN_GO_TARGET = service.url
  vite = await createServer({ root, server: { host: '127.0.0.1', port: 4174, strictPort: true } })
  controller.signal.throwIfAborted()
  await vite.listen()
  const result = await service.exited
  process.exitCode = result.code ?? (result.signal ? 1 : 0)
} catch (error) { if (!controller.signal.aborted) throw error }
finally {
  await stop(); await rm(temporary, { recursive: true, force: true })
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop)
}
