import { spawn } from 'node:child_process'
import { buildGo } from './build-go.mjs'

const controller = new AbortController()
let child
const stop = signal => { controller.abort(); child?.kill(signal) }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal))
try {
  const binary = await buildGo(undefined, undefined, { signal: controller.signal })
  controller.signal.throwIfAborted()
  child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)) })
} catch (error) { process.exitCode = 1; if (!controller.signal.aborted) console.error(error.message) }
