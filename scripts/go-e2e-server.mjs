import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { hostTarget, root } from './build-go.mjs'

const executable = join(root, 'artifacts/go', hostTarget, process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin')
const child = spawn(executable, ['_serve', '--home', `${process.env.LOGIC_MARGIN_DATA_DIR}-home`, '--port', '4173', '--host', '127.0.0.1', '--instance-id', 'go-e2e', '--shutdown-token', 'go-e2e'], { stdio: 'inherit' })
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => child.kill(name))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 0 })
