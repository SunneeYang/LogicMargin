import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { createReviewServer } from '../server/runtime.ts'
import { loadUiAssets } from '../server/ui-assets.ts'
import { parseReview } from '../src/model.ts'

const samples = Number(process.env.PERF_SAMPLES ?? 5)
if (!Number.isSafeInteger(samples) || samples < 3) throw new Error('PERF_SAMPLES must be at least 3')
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], rawMs: values }
}
const temporary = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-browser-perf-'))
let server, browser
try {
  const source = JSON.parse(await readFile(new URL('../public/reviews/task-pipeline.logic-margin.json', import.meta.url), 'utf8'))
  const fixtures = []
  for (const [name, nodeCount, commentCount, rounds] of [
    ['task-pipeline-r1-c0', 42, 0, 1], ['real-shape-42-r10-c200', 42, 200, 10],
    ['synthetic-200-r10-c200', 200, 200, 10], ['synthetic-1000-r10-c1000', 1000, 1000, 10],
  ]) {
    let review = structuredClone(source)
    if (nodeCount !== 42) {
      review.scenes = [{ id: 'stress', title: '单场景压力样本', description: '合成负载，不代表真实业务。' }]
      review.nodes = Array.from({ length: nodeCount }, (_, index) => ({ ...source.nodes[0], id: `node-${index}`, sceneId: 'stress', title: `步骤 ${index + 1}`, evidence: [], position: { x: 0, y: index * 220 } }))
      review.edges = review.nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, sceneId: 'stress', source: review.nodes[index].id, target: node.id, label: '继续', detail: '压力测试连线' }))
    }
    review.comments = Array.from({ length: commentCount }, (_, index) => ({ id: `comment-${index}`, body: `性能样本意见 ${index + 1}，核对输入、校验条件和失败后的状态。`,
      targets: [{ kind: 'node', id: review.nodes[index % review.nodes.length].id }], status: 'open', createdAt: '2026-11-03T00:00:00Z', revision: review.revision, originRound: 1,
      replies: [{ id: `reply-${index}`, author: 'agent', body: '已修改并发布，请结合当前流程核对。', createdAt: '2026-11-03T00:00:00Z', revision: review.revision, round: 1 }] }))
    review = parseReview(review)
    const id = randomUUID()
    const history = Array.from({ length: rounds - 1 }, (_, index) => ({ schemaVersion: 1, kind: 'logic-margin-feedback', id: `submission-${index}`, createdAt: `2026-11-03T00:${String(index).padStart(2, '0')}:00Z`, review }))
    const session = { schemaVersion: 1, id, version: rounds, round: rounds, phase: 'awaiting-review', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T01:00:00Z', review, history,
      snapshots: Array.from({ length: rounds }, (_, index) => ({ round: index + 1, openedAt: '2026-11-03T00:00:00Z', review, ...(index ? { afterSubmission: `submission-${index - 1}` } : {}) })) }
    const raw = JSON.stringify(session)
    if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error(`${name} exceeds the session limit`)
    await writeFile(join(temporary, `${id}.json`), raw)
    fixtures.push({ name, id, nodeCount, commentCount, rounds, payloadBytes: Buffer.byteLength(raw), initiallyVisibleNodes: review.nodes.filter(node => node.sceneId === review.scenes[0].id).length })
  }
  server = await createReviewServer({ assets: await loadUiAssets(resolve('dist')), dataDir: temporary, instanceId: randomUUID(), shutdownToken: randomUUID(), version: 'perf-only', host: '127.0.0.1', port: 0 })
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
  const results = []
  for (const fixture of fixtures) {
    const cold = [], warm = [], comments = [], selection = [], before = [], current = [], edits = [], replies = [], details = []
    for (let index = 0; index < samples; index++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      await context.addInitScript(() => {
        window.__perf = { readyMs: 0, longTasks: [] }
        new PerformanceObserver(list => window.__perf.longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true })
        const observer = new MutationObserver(() => {
          if (!window.__perf.readyMs && document.querySelector('.canvas[data-viewport-ready="true"]')) {
            requestAnimationFrame(() => requestAnimationFrame(() => { window.__perf.readyMs ||= performance.now() }))
          }
        })
        observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-viewport-ready'] })
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${server.url}/?session=${fixture.id}`)
      await page.waitForFunction(() => window.__perf.readyMs > 0, undefined, { timeout: 30000 })
      cold.push(await page.evaluate(() => window.__perf.readyMs))
      const coldResources = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\/assets\/|\/api\/review-sessions\//.test(entry.name)).map(entry => ({ name: new URL(entry.name).pathname, durationMs: entry.duration, encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize, transferBytes: entry.transferSize })))
      await page.reload()
      await page.waitForFunction(() => window.__perf.readyMs > 0)
      warm.push(await page.evaluate(() => window.__perf.readyMs))
      const action = (kind, name) => page.evaluate(({ kind, name }) => new Promise((resolve, reject) => {
        const start = performance.now()
        const button = kind === 'selection' ? document.querySelector('.react-flow__node')
          : [...document.querySelectorAll('.graph-toolbar button')].find(element => element.textContent === name)
        if (!button) { reject(new Error(`Missing ${kind}: ${name}`)); return }
        let checking = false
        const observer = new MutationObserver(check)
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Action timed out: ${kind}`)) }, 30000)
        function check() {
          const ready = kind === 'selection' ? document.querySelector('.react-flow__node.selected')
            : kind === 'comments' ? document.querySelector('.inspector.is-open .comment-filter')
              : document.querySelector(`.canvas${kind === 'before' ? '[data-readonly="true"]' : ':not([data-readonly="true"])'}[data-viewport-ready="true"]`)
          if (!ready || checking) return
          checking = true
          observer.disconnect(); clearTimeout(timer)
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))
        }
        observer.observe(document.body, { subtree: true, childList: true, attributes: true })
        button.click(); check()
      }), { kind, name })
      selection.push(await action('selection', ''))
      comments.push(await action('comments', `批注 ${fixture.commentCount}`))
      if (fixture.rounds > 1) {
        before.push(await action('before', `修改前 R${fixture.rounds - 1}`))
        current.push(await action('current', `当前 R${fixture.rounds}`))
      }
      if (fixture.commentCount) {
        await page.locator('.comment-actions button').first().click()
        await page.locator('[data-composer] textarea').fill('性能基准回复')
        for (let edit = 0; edit < 3; edit++) edits.push(await page.evaluate(() => new Promise(resolve => {
          const textarea = document.querySelector('[data-composer] textarea')
          const start = performance.now()
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, textarea.value + '。')
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))
        })))
        replies.push(await page.evaluate(() => new Promise((resolve, reject) => {
          const start = performance.now()
          const observer = new MutationObserver(() => {
            if (!document.querySelector('[data-composer]') && document.querySelector('.save-state')?.textContent === '已保存到会话') {
              observer.disconnect(); clearTimeout(timer)
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))
            }
          })
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Reply sync timed out')) }, 30000)
          observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
          document.querySelector('[data-composer] form').requestSubmit()
        })))
      }
      const detail = await page.evaluate(() => ({
        domNodes: document.querySelectorAll('*').length,
        longTasks: window.__perf.longTasks,
        resources: performance.getEntriesByType('resource').filter(entry => /\/assets\/|\/api\/review-sessions\//.test(entry.name)).map(entry => ({ name: new URL(entry.name).pathname, durationMs: entry.duration, encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize, transferBytes: entry.transferSize })),
      }))
      details.push({ ...detail, coldResources })
      if (errors.length) throw new Error(`${fixture.name}: ${errors.join('; ')}`)
      await context.close()
    }
    const api = details[0].coldResources.find(item => item.name === `/api/review-sessions/${fixture.id}`)
    results.push({ ...fixture, storedSessionBytes: fixture.payloadBytes, payloadBytes: api?.decodedBytes ?? 0, compressedPayloadBytes: api?.encodedBytes ?? 0, coldReady: quantiles(cold), warmReady: quantiles(warm), selectNodeTwoPaints: quantiles(selection), openCommentsTwoPaints: quantiles(comments),
      ...(before.length ? { beforeReadyTwoPaints: quantiles(before), currentReadyTwoPaints: quantiles(current) } : {}),
      ...(edits.length ? { composerEditTwoPaints: quantiles(edits), saveReplyUntilSyncedTwoPaints: quantiles(replies) } : {}), details })
    console.log(JSON.stringify({ name: fixture.name, payloadBytes: api?.decodedBytes, compressedPayloadBytes: api?.encodedBytes, coldReadyMs: cold, warmReadyMs: warm,
      openCommentsMs: comments, saveReplyMs: replies }))
  }
  await mkdir('artifacts/performance', { recursive: true })
  await writeFile('artifacts/performance/browser.json', JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), browser: await browser.version(), viewport: '1440x900', note: 'Production UI, localhost, desktop CPU, no network/CPU throttling; non-real cases are synthetic; two-paint interaction timers include up to two frame waits. First load of each fresh context is cold HTTP cache; warm is reload.', results }, null, 2))
} finally {
  await browser?.close()
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
