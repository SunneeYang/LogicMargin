import { sourceExampleURL } from './ui.ts'
import { test, expect } from '@playwright/test'
import { commentScope, expectRevision, openMenu, openPipelineReview, openInspector } from './ui.ts'
import type { Download } from '@playwright/test'
import type { ReviewDocument, ReviewRecord } from '../src/types.ts'
import { sampleReview } from '../src/sample.ts'
import { addComment } from '../src/model.ts'
import { makeDraft } from '../src/workspace.ts'

test.use({ baseURL: sourceExampleURL })

async function readDownload<T>(download: Download): Promise<T> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString())
}

const title = '虚构演示 · 任务流水线'
const storageKey = 'logic-margin:review:demo-task-pipeline-v1'

test('new example identities preserve unrelated stored reviews and drafts without merging them', async ({ page }) => {
  const previous = addComment({ ...structuredClone(sampleReview), id: 'demo-previous-v0' }, [{ kind: 'node', id: 'upgrade-start' }], '另一份评审的意见')
  const draft = makeDraft(previous, [{ kind: 'node', id: 'upgrade-start' }], '另一份评审的草稿')
  await page.addInitScript(({ previous, draft }) => {
    localStorage.setItem(`logic-margin:review:${previous.id}`, JSON.stringify(previous))
    localStorage.setItem('logic-margin:drafts', JSON.stringify([draft]))
  }, { previous, draft })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: sampleReview.title, exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!).comments.length, sampleReview.id)).toBe(0)
  await openPipelineReview(page)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).comments.length, storageKey)).toBe(0)
  const stored = await page.evaluate(id => ({
    review: JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!),
    drafts: JSON.parse(localStorage.getItem('logic-margin:drafts')!),
  }), previous.id)
  expect(stored.review).toEqual(previous)
  expect(stored.drafts).toEqual([draft])
})

test('the fictional pipeline opens by link and completes review without the secure-context UUID API', async ({ page, request }) => {
  await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }))
  const payload = await request.get('/reviews/task-pipeline.logic-margin.json')
  expect(payload.ok()).toBe(true)
  const source: ReviewDocument = await payload.json()
  expect(source.id).toBe('demo-task-pipeline-v1')
  expect(source.comments).toEqual([])
  expect(source.snapshot.dirty).toBe(false)
  expect(source.scenes).toHaveLength(5)
  expect(source.nodes.every(node => node.evidence.length > 0)).toBe(true)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/?review=task-pipeline')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  const node = source.nodes.find(item => item.sceneId === source.scenes[0].id)!
  await page.locator(`.react-flow__node[data-id="${node.id}"]`).click({ button: 'right' })
  const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await editor.getByLabel('问题与预期行为').fill('交互验收：请核对无效模板被拒绝时，原有任务记录保持不变。')
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(editor.getByLabel('问题与预期行为')).toHaveCount(0)
  await editor.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await openInspector(page, 'comments')
  await page.getByRole('button', { name: '回复讨论', exact: true }).click()
  await page.getByLabel('补充说明').fill('交互验收：外部执行器没有接入，应保留在本轮覆盖边界中。')
  await page.getByRole('button', { name: '保存回复', exact: true }).click()
  const feedbackDownload = page.waitForEvent('download')
  await page.locator('.topbar').getByRole('button', { name: '提交本轮（1）', exact: true }).click()
  await page.getByRole('button', { name: '生成意见包', exact: true }).click()
  const feedback = await readDownload<ReviewRecord>(await feedbackDownload)
  expect(feedback.review.snapshot).toEqual(source.snapshot)
  expect(feedback.review.comments[0].targets).toEqual([{ kind: 'node', id: node.id }])
  expect(feedback.review.comments[0].replies).toHaveLength(1)
  expect(feedback.review.comments[0].id).toMatch(/^[a-f0-9-]{36}$/)
  await expect(page.getByText('意见包已生成，待交给代理。文件包含本轮意见与固定流程快照。', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  const saved: ReviewDocument = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey)
  expect(saved.comments).toHaveLength(1)
  const response = structuredClone(saved)
  response.comments[0].replies!.push({ id: 'acceptance-agent-response', author: 'agent', body: '交互验收回执：按演示规则核对，模板校验发生在创建队列项之前。', createdAt: new Date().toISOString(), revision: source.revision })
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'acceptance-response.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(response)) })
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).comments[0].status, storageKey)).toBe('needs-review')
  await openInspector(page, 'comments')
  await page.getByRole('button', { name: '复核并确认解决', exact: true }).click()
  await page.locator('.topbar').getByRole('button', { name: '完成审查', exact: true }).click()
  const approvalDownload = page.waitForEvent('download')
  await page.locator('.feedback-summary').getByRole('button', { name: '确认整轮通过', exact: true }).click()
  const approval = await readDownload<ReviewRecord>(await approvalDownload)
  expect(approval.kind).toBe('logic-margin-approval')
  expect(approval.review.comments[0].status).toBe('resolved')
  expect(approval.review.coverage).toEqual(source.coverage)
  expect(errors).toEqual([])
})

test('opening the fictional pipeline preserves another review and current-version local opinions', async ({ page }) => {
  await page.goto('/')
  await commentScope(page, 'review')
  await page.getByLabel('问题与预期行为').fill('旧评审未完成的意见草稿。')
  await page.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await openPipelineReview(page)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  const stored = await page.evaluate(id => ({ review: localStorage.getItem(`logic-margin:review:${id}`), drafts: JSON.parse(localStorage.getItem('logic-margin:drafts')!) }), sampleReview.id)
  expect(stored.review).not.toBeNull()
  expect(stored.drafts[0]).toMatchObject({ documentId: sampleReview.id, body: '旧评审未完成的意见草稿。' })
  await commentScope(page, 'scene')
  await page.getByLabel('问题与预期行为').fill('交互验收：保留流水线本机意见。')
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  await page.goto('/?review=task-pipeline')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).comments.length, storageKey)).toBe(1)
})

test('a failed package download preserves the current review and retry stays available on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.route('**/reviews/task-pipeline.logic-margin.json', route => route.fulfill({ status: 503, body: 'Unavailable' }))
  await page.goto('/?review=task-pipeline')
  await expect(page.getByRole('alert')).toContainText('打开任务流水线失败')
  await expect(page.getByRole('heading', { name: sampleReview.title, exact: true })).toBeVisible()
  await openMenu(page, '.file-menu')
  await expect(page.getByRole('button', { name: '打开任务流水线评审', exact: true })).toBeVisible()
  await page.unroute('**/reviews/task-pipeline.logic-margin.json')
  await openPipelineReview(page)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('manual new revisions and cached deep links never downgrade to the bundled snapshot on reload', async ({ page, request }) => {
  const response = await request.get('/reviews/task-pipeline.logic-margin.json')
  const newer: ReviewDocument = await response.json()
  newer.revision = 'acceptance-v2'
  newer.snapshot.fingerprint = 'acceptance-newer-source'
  newer.nodes[0].summary = '交互验收：后续导入的新版本。'
  await page.goto('/?review=task-pipeline')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'newer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(newer)) })
  await expectRevision(page, 'acceptance-v2')
  await expect(page).not.toHaveURL(/review=task-pipeline/)
  await page.reload()
  await expectRevision(page, 'acceptance-v2')
  await page.evaluate(id => localStorage.setItem('logic-margin:active', id), sampleReview.id)
  await page.goto('/?review=task-pipeline')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expectRevision(page, 'acceptance-v2')
})
