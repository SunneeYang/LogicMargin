import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(import.meta.resolve('@playwright/test/cli'))
const child = spawn(process.execPath, [entry, 'test', ...process.argv.slice(2)], { stdio: 'inherit' })
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => child.kill(name))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
