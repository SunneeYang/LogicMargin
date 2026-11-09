import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { SessionStore } from '../server/session-store.ts'
import { loadUiAssets } from '../server/ui-assets.ts'
import { sampleReview } from '../src/sample.ts'
import { hostTarget, root } from './build-go.mjs'

const binary = process.env.LOGIC_MARGIN_GO_BINARY ?? join(root, 'artifacts/go', hostTarget, process.platform === 'win32' ? 'logic-margin.exe' : 'logic-margin')
const output = resolve(process.argv[2] ?? join(root, '.scratch/go-migration-benchmark.json'))
const temp = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-go-bench-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const date = '2026-11-08T12:00:00.000Z'
const quantiles = values => {
  const sorted = [...values].sort((a,b) => a-b)
  return { median: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)], samples: values }
}
let active

try {
  const seedDir = join(temp, 'seed')
  const store = new SessionStore(seedDir)
  const review = structuredClone(sampleReview)
  review.comments = []
  review.nodes.forEach(node => { node.evidence = [] })
  const files = [{ path: 'fixture.ts', sha256: hash('fixed comparison source') }]
  const fingerprint = hash(JSON.stringify(files))
  review.snapshot = { ...review.snapshot, files, fingerprint }
  let state = await store.create(review)
  for (let round=1; round<=10; round++) {
    state = await store.mutate(state.id, { round, revision: state.review.revision, fingerprint, mutations: Array.from({ length:20 },(_,index) => ({ kind:'add-comment', comment: {
      id:`bench-${round}-${index}`, targets:[{kind:'node',id:review.nodes[index%review.nodes.length].id}], revision:state.review.revision,
      body:'核对来源、输入、输出与失败分支。'.repeat(8), status:'open', createdAt:date,
    } })) })
    if (round === 10) break
    state = await store.finish(state.id,{ expectedVersion:state.version, kind:'feedback' })
    const next = structuredClone(state.review)
    next.revision = `bench-r${round+1}`
    next.nodes[0].summary += ` R${round+1}`
    state = await store.revise(state.id,{ expectedVersion:state.version, review:next, publication:{ baseRound:round, summary:'固定基准发布', source:{ algorithm:'sha256-path-content-v1', checkedAt:date, files, fingerprint } } })
  }
  const assets = await loadUiAssets(join(root, 'internal/ui/dist'))
  const entry = join(temp, 'node-entry.mjs')
  const moduleURL = pathToFileURL(join(root, 'bin/main.ts')).href
  await writeFile(entry, `import {runMain} from ${JSON.stringify(moduleURL)};await runMain(process.argv.slice(2),{command:[process.execPath,process.argv[1]],assets:${JSON.stringify(assets)}});\n`)
  const starts = { node:[], go:[] }, requestTimes = { node:[], go:[] }
  const responseBytes = {}
  const versions = {}
  for (let iteration=0; iteration<5; iteration++) for (const backend of iteration%2 ? ['go','node'] : ['node','go']) {
    const home = join(temp,`${backend}-${iteration}`)
    const data = join(home,'sessions')
    await mkdir(data,{recursive:true})
    await cp(join(seedDir,`${state.id}.json`),join(data,`${state.id}.json`))
    const command = backend === 'node' ? [process.execPath,entry] : [binary]
    const started = performance.now()
    const child = spawn(command[0],[...command.slice(1),'_serve','--home',home,'--port','0','--instance-id',backend,'--shutdown-token',backend],
      {cwd:temp,env:{...process.env,PATH:join(temp,'no-js-runtimes'),LOGIC_MARGIN_HOME:home,LOGIC_MARGIN_DATA_DIR:data},stdio:['ignore','pipe','pipe']})
    const exited = once(child,'exit')
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data',chunk => { stderr += chunk })
    const lines = createInterface({input:child.stdout})
    active = {child,exited,lines}
    const [line] = await Promise.race([once(lines,'line'),exited.then(()=>{throw new Error(stderr || 'server exited')}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);timer.unref()})])
    const base = JSON.parse(line).url
    starts[backend].push(performance.now()-started)
    const health = await (await fetch(base+'/api/health')).json()
    versions[backend] = health.version
    for (let index=0; index<30; index++) {
      const started = performance.now()
      const response = await fetch(`${base}/api/review-sessions/${state.id}?view=current`,{headers:{'accept-encoding':'identity'}})
      assert.equal(response.status,200)
      const bytes = await response.arrayBuffer()
      const elapsed = performance.now()-started
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
      assert.equal(parsed.review.comments.length,200)
      assert.equal(parsed.snapshots.length,10)
      assert.equal(parsed.history.length,9)
      responseBytes[backend] = bytes.byteLength
      if (index>=5) requestTimes[backend].push(elapsed)
    }
    await fetch(base+'/api/shutdown',{method:'POST',headers:{'x-logic-margin-token':backend}})
    const kill = setTimeout(()=>child.kill(),5000)
    try { await exited } finally { clearTimeout(kill);lines.close();active=undefined }
  }
  const raw = await readFile(join(seedDir,`${state.id}.json`))
  const result = {capturedAt:new Date().toISOString(),baseline:'73890315827d0c335f360fcf467c33049fdb17cf',
    machine:{cpu:cpus()[0].model,os:platform(),release:release(),arch:process.arch,node:process.version},versions,
    scope:'Process spawn through _serve ready; then sequential identity-encoded current-view HTTP requests including body consumption, excluding JSON parsing. Five interleaved launches per backend, five warmups and 25 samples each. Identical saved JSON and UI assets. Filesystem/process caches are not flushed.',
    fixture:{rounds:10,comments:200,historyRecords:9,jsonBytes:raw.length,sha256:hash(raw)},responseBytes,
    startupMs:Object.fromEntries(Object.entries(starts).map(([key,values])=>[key,quantiles(values)])),
    warmCurrentHTTPMs:Object.fromEntries(Object.entries(requestTimes).map(([key,values])=>[key,quantiles(values)])),
    excluded:'CPU/RSS, cold disk/cache, mutation/publication latency, diff precomputation, browser rendering, phones and other platforms. No claim about multiuser collaboration or universal Go speedup.'}
  await mkdir(dirname(output),{recursive:true})
  await writeFile(output,JSON.stringify(result,null,2)+'\n')
  console.log(output)
} finally {
  if (active) { active.child.kill(); await active.exited.catch(()=>{});active.lines.close() }
  await rm(temp,{recursive:true,force:true})
}
