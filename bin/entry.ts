import { runMain } from './main.ts'

runMain(process.argv.slice(2)).catch(error => {
  process.stderr.write(`LogicMargin: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
