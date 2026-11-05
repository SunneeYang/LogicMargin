import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { APIRequestContext, Download, Page } from '@playwright/test'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { CurrentSession, ReviewSession } from '../src/session-types.ts'
import type { ReviewDocument } from '../src/types.ts'
import { openInspector, openMenu } from './ui.ts'

function sourceSnapshot(review: ReviewDocument, version: string) {
  const files = [{ path: 'baseline-fixture.ts', sha256: createHash('sha256').update(`${version}\n`).digest('hex') }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { ...review.snapshot, files, fingerprint }
}

function originalGraph(id: string): ReviewDocument {
  const review = structuredClone(sampleReview)
  review.id = id
  review.title = '基线批注与实现对照'
  review.revision = 'original-system-v0'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.slice(0, 3).map((node, index) => ({ ...node, evidence: [], position: { x: 0, y: index * 180 } }))
  review.edges = [
    { id: 'original-entry', sceneId: 'upgrade', source: 'upgrade-start', target: 'upgrade-toggle', label: '检查开关', detail: '进入原有开关检查。' },
    { id: 'original-gate', sceneId: 'upgrade', source: 'upgrade-toggle', target: 'upgrade-level', label: '已开放', detail: '功能开放后继续。' },
    { id: 'shared-step', sceneId: 'upgrade', source: 'upgrade-start', target: 'upgrade-level', label: '原有资格', detail: '按原有资格进入等级检查。' },
  ]
  review.comments = []
  review.snapshot = sourceSnapshot(review, 'baseline-source')
  return review
}

function implementation(baseline: ReviewDocument): ReviewDocument {
  const review = structuredClone(baseline)
  review.revision = 'implementation-v1'
  review.snapshot = sourceSnapshot(review, 'implementation-source-v1')
  review.nodes = review.nodes.filter(node => node.id !== 'upgrade-toggle')
  review.nodes[0].summary = '新版规则：进入前先核对本轮资格。'
  review.nodes.push({ ...review.nodes[1], id: 'settlement-check', title: '结算前再次核对资格', summary: '结算时再次核对，拒绝时保留原状态。', position: { x: 0, y: 540 } })
  review.edges = review.edges.filter(edge => edge.id === 'shared-step').map(edge => ({ ...edge, label: '本轮资格通过' }))
  review.edges.push({ id: 'new-settlement', sceneId: 'upgrade', source: 'upgrade-level', target: 'settlement-check', label: '结算前复核', detail: '扣费前再次核对资格。' })
  return { ...review, baseline: structuredClone(baseline) }
}

async function createSession(request: APIRequestContext, review: ReviewDocument, baselineReview?: true) {
  const response = await request.post('/api/review-sessions', { data: { review, ...(baselineReview ? { baselineReview } : {}) } })
  expect(response.ok()).toBeTruthy()
  return await response.json() as ReviewSession
}

async function getSession(request: APIRequestContext, id: string): Promise<ReviewSession> {
  const response = await request.get(`/api/review-sessions/${id}`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function publish(request: APIRequestContext, state: ReviewSession, next: ReviewDocument): Promise<ReviewSession> {
  next.snapshot = sourceSnapshot(next, `published-implementation-${state.round + 1}`)
  const { files, fingerprint } = next.snapshot
  const response = await request.post(`/api/review-sessions/${state.id}/revise`, { data: {
    expectedVersion: state.version, review: next,
    publication: { baseRound: state.round, summary: '测试夹具：按基线改造意见调整资格检查。',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } },
    replies: state.review.comments.map(comment => ({ commentId: comment.id, body: '代理：已调整资格检查和失败出口，请核对 R1。' })),
  } })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function downloadedReview(download: Download): Promise<ReviewDocument> {
  const stream = await download.createReadStream()
  expect(stream).not.toBeNull()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString())
}

async function readyCanvas(page: Page) {
  const canvas = page.getByLabel('业务流程画布', { exact: true })
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  return canvas
}

test('importing another review keeps each fixed baseline with its own document', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const load = async (review: ReviewDocument) => {
    await page.getByLabel('导入评审文件').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
    await readyCanvas(page)
  }
  await page.goto('/')
  await load(implementation(originalGraph('first-baseline-document')))
  await expect(page.getByRole('button', { name: '基线 B', exact: true })).toBeVisible()

  const next = originalGraph('independent-document')
  next.title = '独立评审'
  await load(next)
  await expect(page.getByRole('button', { name: '基线 B', exact: true })).toHaveCount(0)
  const download = page.waitForEvent('download')
  const menu = await openMenu(page, '.file-menu')
  await menu.getByRole('button', { name: '导出评审', exact: true }).click()
  expect((await downloadedReview(await download)).baseline).toBeUndefined()

  const third = implementation(originalGraph('third-baseline-document'))
  third.baseline!.nodes[0].summary = '第三份评审自己的原版规则。'
  await load(third)
  await page.getByRole('button', { name: '基线 B', exact: true }).click()
  await expect(page.locator('.react-flow__node[data-id="upgrade-start"]')).toContainText('第三份评审自己的原版规则。')
  expect(errors).toEqual([])
})

test('B preserves the unmarked original while R1 shows changes on a stable layout and exports the fixed baseline', async ({ page, request }, info) => {
  const baseline = originalGraph('baseline-direct-review')
  const currentReview = implementation(baseline)
  currentReview.scenes[0] = { ...currentReview.scenes[0], title: '本轮资格与结算复核', description: 'R1：核对新版资格规则与结算前复核。' }
  const session = await createSession(request, currentReview)
  const path = `/api/review-sessions/${session.id}`
  let baselineRequests = 0
  const currentRequests: URL[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === `${path}/baseline`) baselineRequests++
    if (url.pathname === path) currentRequests.push(url)
  })
  await page.goto(`/?session=${session.id}`)
  await readyCanvas(page)
  await expect(page.getByRole('button', { name: '当前 R1', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.scene-title')).toHaveText(currentReview.scenes[0].title)
  const start = page.locator('.react-flow__node[data-id="upgrade-start"]')
  const level = page.locator('.react-flow__node[data-id="upgrade-level"]')
  await expect(start).toContainText('已修改')
  await expect(page.locator('.react-flow__node[data-id="settlement-check"]')).toContainText('新增')
  await expect(page.locator('.react-flow__edge[data-id="new-settlement"]')).toHaveClass(/revision-added/)
  await expect(page.locator('.react-flow__edge[data-id="shared-step"]')).toHaveClass(/revision-changed/)
  const coordinates = [await start.evaluate(element => element.style.transform), await level.evaluate(element => element.style.transform)]
  await page.screenshot({ path: info.outputPath('baseline-current-r1-desktop.png') })
  await page.getByRole('button', { name: '本次改动', exact: true }).click()
  const changes = page.getByRole('region', { name: '本次改动', exact: true })
  const changedNode = changes.getByRole('region', { name: '修改项', exact: true }).locator('article').filter({ hasText: '发起总等级升级' })
  await expect(changedNode.locator('.revision-before').filter({ hasText: baseline.nodes[0].summary })).toBeVisible()
  await expect(changedNode.locator('.revision-after').filter({ hasText: '新版规则：进入前先核对本轮资格。' })).toBeVisible()
  await changes.getByRole('button', { name: '定位原位置：通灵功能是否开放？', exact: true }).click()
  await readyCanvas(page)
  await expect(page.getByRole('button', { name: '基线 B', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.scene-title')).toHaveText(baseline.scenes[0].title)
  await expect(page.locator('.scene-title')).toHaveAttribute('title', `${baseline.scenes[0].title} · ${baseline.scenes[0].description}`)
  await expect(start).toContainText(baseline.nodes[0].summary)
  await expect(start).not.toContainText('新版规则：进入前先核对本轮资格。')
  await expect(page.locator('.react-flow__node[data-id="upgrade-toggle"]')).toContainText(baseline.nodes[1].title)
  await expect(page.locator('.react-flow__node .revision-badge')).toHaveCount(0)
  await expect(page.locator('.react-flow__edge[class*="revision-"]')).toHaveCount(0)
  await expect(page.locator('.react-flow__edge[data-id="shared-step"]')).toContainText('原有资格')
  await expect(page.locator('.canvas-caption')).toContainText('基线 B · 原版流程')
  await expect.poll(async () => [await start.evaluate(element => element.style.transform), await level.evaluate(element => element.style.transform)]).toEqual(coordinates)
  await page.getByRole('button', { name: '当前 R1', exact: true }).click()
  await readyCanvas(page)
  await expect(start).toContainText('已修改')
  await expect(page.locator('.react-flow__edge[data-id="shared-step"]')).toHaveClass(/revision-changed/)
  await expect.poll(async () => [await start.evaluate(element => element.style.transform), await level.evaluate(element => element.style.transform)]).toEqual(coordinates)
  await expect.poll(() => baselineRequests).toBe(1)

  const updated = addComment(session.review, [{ kind: 'node', id: 'upgrade-start' }], '检查轻量轮询后的批注。')
  const pollResponse = page.waitForResponse(response => new URL(response.url()).pathname === path && response.url().includes('afterVersion=') && response.status() === 200)
  const saved = await request.post(`${path}/mutations`, { data: {
    round: session.round, revision: session.review.revision, fingerprint: session.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment: updated.comments[0] }],
  } })
  expect(saved.ok()).toBeTruthy()
  const current = await (await pollResponse).json() as CurrentSession
  expect(current.review.baseline).toBeUndefined()
  expect(current.baseline?.revision).toBe(baseline.revision)
  await expect(page.locator('.canvas-caption')).toContainText('1 条待处理意见')
  expect(currentRequests.every(url => url.searchParams.get('view') === 'current')).toBe(true)
  expect(baselineRequests).toBe(1)
  const download = page.waitForEvent('download')
  const menu = await openMenu(page, '.file-menu')
  await menu.getByRole('button', { name: '导出评审', exact: true }).click()
  const exported = await downloadedReview(await download)
  expect(exported.baseline).toEqual(baseline)
  expect(exported.comments).toHaveLength(1)
  expect(baselineRequests).toBe(1)
})

test('legacy sessions explain the missing baseline and can retry a failed baseline after it is attached', async ({ page, request }) => {
  const baseline = originalGraph('baseline-recovery-review')
  const review = implementation(baseline)
  delete review.baseline
  const session = await createSession(request, review)
  const path = `/api/review-sessions/${session.id}`
  await page.goto(`/?session=${session.id}`)
  await readyCanvas(page)
  await page.getByRole('button', { name: '变更对比', exact: true }).click()
  await expect(page.getByRole('heading', { name: '未提供修改前基线', exact: true })).toBeVisible()
  await expect(page.getByText(/无逻辑变化/)).toHaveCount(0)
  await page.route(`**${path}/baseline`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：基线读取暂时失败' }) }))
  const attached = await request.post(`${path}/baseline`, { data: { expectedVersion: session.version, baseline } })
  expect(attached.ok()).toBeTruthy()
  await expect(page.getByRole('button', { name: '基线 B', exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '测试：基线读取暂时失败' })).toBeVisible()
  await expect(page.getByText(/无逻辑变化/)).toHaveCount(0)
  await page.unroute(`**${path}/baseline`)
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.getByRole('region', { name: '本次改动', exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: '测试：基线读取暂时失败' })).toHaveCount(0)
  expect((await getSession(request, session.id)).round).toBe(1)
  expect((await getSession(request, session.id)).review.baseline).toEqual(baseline)
})

test('implementation discussions retain their canvas while explicit baseline navigation restores editable B', async ({ page, request }) => {
  const baseline = originalGraph('baseline-discussion-navigation')
  const target = [{ kind: 'node', id: 'upgrade-start' }] as const
  let review = addComment(implementation(baseline), [...target], '当前实现的复核问题。')
  review = addComment(review, [...target], '基线改造要求：结算前复核资格。', 'baseline')
  const first = await createSession(request, review)
  const next = structuredClone(first.review)
  next.revision = 'implementation-v2'
  next.nodes[0].summary = 'R2：记录本轮资格复核结果。'
  const session = await publish(request, first, next)
  await page.goto(`/?session=${session.id}`)
  await readyCanvas(page)
  await page.getByRole('button', { name: '批注：发起总等级升级（2 条）', exact: true }).click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await expect(discussion).toContainText('基线改造要求：结算前复核资格。')
  await expect(discussion).toContainText('当前实现的复核问题。')
  await expect(page.getByRole('button', { name: '当前 R2', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await discussion.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await page.getByLabel('比较依据', { exact: true }).selectOption('previous')
  await page.getByRole('button', { name: '修改前 R1', exact: true }).click()
  await readyCanvas(page)
  await openInspector(page, 'comments')
  const baselineComment = page.getByRole('article', { name: '意见 2', exact: true })
  await baselineComment.getByRole('button', { name: '展开意见 2 的完整讨论', exact: true }).click()
  await readyCanvas(page)
  await expect(page.getByLabel('业务流程画布', { exact: true })).not.toHaveAttribute('data-readonly', 'true')
  await expect(discussion).toContainText('基线 B ·')
  await expect(discussion).not.toContainText('当前实现的复核问题。')
  await expect(discussion.getByRole('button', { name: '回复当前意见', exact: true })).toBeEnabled()
  await discussion.getByRole('button', { name: '回复当前意见', exact: true }).click()
  await discussion.getByLabel('补充说明').fill('在基线原位置补充改造约束。')
  await discussion.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect.poll(async () => (await getSession(request, session.id)).review.comments[1].replies?.length).toBe(2)
})

test('baseline-first redesign submits saved comments and drafts, publishes implementation R1 and preserves their baseline origins for human review', async ({ page, request }, info) => {
  const baseline = originalGraph('baseline-first-redesign')
  const session = await createSession(request, { ...structuredClone(baseline), baseline: structuredClone(baseline) }, true)
  const path = `/api/review-sessions/${session.id}`
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/?session=${session.id}`)
  const canvas = await readyCanvas(page)
  await openMenu(page, '.canvas-tools')
  await expect(page.getByRole('button', { name: '基线 B', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: /^当前 R/ })).toHaveCount(0)
  await expect(canvas).not.toHaveAttribute('data-readonly', 'true')
  await page.locator('summary[aria-label="画布工具"]').click()
  await page.getByRole('button', { name: '批注：通灵功能是否开放？', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '基线 B 批注', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByLabel('问题与预期行为').fill('改造要求：把开关检查改为资格检查，失败时保留资源。')
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect.poll(async () => (await getSession(request, session.id)).review.comments.length).toBe(1)
  await page.getByRole('button', { name: '批注：发起总等级升级', exact: true }).click()
  await editor.getByLabel('问题与预期行为').fill('改造要求草稿：结算前还要再核对一次资格。')
  await editor.getByRole('button', { name: '关闭编辑器并保留草稿', exact: true }).click()
  await expect(page.locator('[data-composer]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('baseline-first-mobile.png') })
  await page.locator('.topbar').getByRole('button', { name: /^提交改造意见/ }).click()
  await page.getByRole('button', { name: '保存草稿并提交', exact: true }).click()
  await expect.poll(async () => (await getSession(request, session.id)).phase).toBe('feedback-ready')
  const submitted = await getSession(request, session.id)
  expect(submitted.review.comments).toHaveLength(2)
  expect(submitted.review.comments.map(comment => comment.basis)).toEqual(['baseline', 'baseline'])
  expect(submitted.review.baseline).toEqual(baseline)
  expect(submitted.review.baseline?.comments).toEqual([])
  const recordResponse = await request.get(`${path}/records/${submitted.history[0].id}`)
  expect(recordResponse.ok()).toBeTruthy()
  const record = await recordResponse.json()
  expect(record.review.baseline).toEqual(baseline)
  expect(record.review.comments.every((comment: { basis?: string }) => comment.basis === 'baseline')).toBe(true)
  expect((await request.post(`${path}/ack`, { data: { submissionId: submitted.history[0].id } })).ok()).toBeTruthy()
  const published = await publish(request, await getSession(request, session.id), implementation(baseline))
  expect(published.round).toBe(2)
  expect(published.review.baseline).toEqual(baseline)
  await openMenu(page, '.canvas-tools')
  await expect(page.getByRole('button', { name: '当前 R1', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('summary[aria-label="画布工具"]').click()
  await openInspector(page, 'comments')
  const comment = page.getByRole('article', { name: '意见 1', exact: true })
  await expect(comment).toContainText('提出于基线 B')
  await expect(comment).toContainText('代理：已调整资格检查和失败出口，请核对 R1。')
  await expect(comment.locator('.status-label')).toContainText('待复核')
  await comment.getByRole('button', { name: /^基线 B · 通灵功能是否开放？/ }).click()
  await readyCanvas(page)
  await expect(page.locator('.react-flow__node[data-id="upgrade-toggle"]')).toBeVisible()
  await page.getByRole('button', { name: '返回当前 R1', exact: true }).click()
  await readyCanvas(page)
  await comment.getByRole('button', { name: '回复讨论', exact: true }).click()
  await page.getByLabel('补充说明').fill('人工补充：已核对原流程与 R1 的失败出口。')
  await page.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect.poll(async () => (await getSession(request, session.id)).review.comments[0].replies?.length).toBe(2)
  await comment.getByRole('button', { name: '复核并确认解决', exact: true }).click()
  await expect.poll(async () => (await getSession(request, session.id)).review.comments[0].status).toBe('resolved')
  const reviewed = await getSession(request, session.id)
  expect(reviewed.review.comments[0].basis).toBe('baseline')
  expect(reviewed.review.comments[0].reviewedRound).toBe(2)
  expect(reviewed.review.baseline).toEqual(baseline)
})

test('R2 can compare against either the fixed B or R1 with usable mobile controls in both themes', async ({ page, request }, info) => {
  const baseline = originalGraph('baseline-later-comparisons')
  const first = await createSession(request, implementation(baseline))
  const next = structuredClone(first.review)
  next.revision = 'implementation-v2'
  next.nodes[0].summary = 'R2：进入时记录资格核对结果。'
  const session = await publish(request, first, next)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/?session=${session.id}`)
  await readyCanvas(page)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('.react-flow')).toHaveClass(new RegExp(`\\b${colorScheme}\\b`))
    await openMenu(page, '.canvas-tools')
    const source = page.getByLabel('比较依据', { exact: true })
    await expect(source).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: '当前 R2', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await source.selectOption('previous')
    await expect(page.getByRole('button', { name: '修改前 R1', exact: true })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: '本轮变化', exact: true }).click()
    const previousChanges = page.getByRole('region', { name: '本轮变化', exact: true })
    await expect(previousChanges).toContainText('R2：进入时记录资格核对结果。')
    await expect(previousChanges.getByRole('region', { name: '移除项', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await openMenu(page, '.canvas-tools')
    await source.selectOption('baseline')
    await expect(page.getByRole('button', { name: '基线 B', exact: true })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: '本次改动', exact: true }).click()
    const baselineChanges = page.getByRole('region', { name: '本次改动', exact: true })
    await expect(baselineChanges.getByRole('region', { name: '移除项', exact: true })).toContainText('通灵功能是否开放？')
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: info.outputPath(`baseline-r2-mobile-${colorScheme}.png`) })
  }
  expect((await getSession(request, session.id)).review.baseline).toEqual(baseline)
})
