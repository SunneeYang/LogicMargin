import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGo, root } from './build-go.mjs'
import { startGo } from './go-process.mjs'

const controller = new AbortController()
let vite, service, stopping = false
const stop = () => { stopping = true; controller.abort(); vite?.kill('SIGTERM'); return service?.stop() }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
const message = value => { if (value === 'stop') stop() }
process.on('message', message)
process.once('disconnect', stop)
try {
  const binary = await buildGo(undefined, undefined, { signal: controller.signal })
  service = await startGo({ binary, dataDir: resolve(process.env.LOGIC_MARGIN_DATA_DIR ?? join(root, '.logic-margin/sessions')), signal: controller.signal })
  controller.signal.throwIfAborted()
  const args = process.argv.slice(2), preview = args[0] === '--preview'
  vite = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), 'bin/vite.js'), ...(preview ? ['preview', ...args.slice(1)] : ['--host', '0.0.0.0', ...args])],
    { cwd: root, env: { ...process.env, LOGIC_MARGIN_GO_TARGET: service.url }, stdio: 'inherit' })
  const exited = new Promise((resolve, reject) => { vite.once('error', reject); vite.once('close', code => resolve(code ?? (stopping ? 0 : 1))) })
  process.exitCode = await Promise.race([exited, service.exited.then(async () => {
    if (stopping) return exited
    vite.kill(); throw new Error(`Go backend exited: ${service.stderr}`)
  })])
} catch (error) {
  if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1 }
} finally {
  await stop()
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop)
  process.removeListener('message', message); process.removeListener('disconnect', stop)
  if (process.connected) process.disconnect()
}
