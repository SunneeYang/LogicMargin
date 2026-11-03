import { test, expect } from '@playwright/test'
import { commentScope, expectRevision, exportReview, openInspector, openMenu } from './ui.ts'
import type { Download, Page } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'
import type { CommentDraft, ReviewDocument, ReviewRecord } from '../src/types.ts'

async function readDownload<T>(download: Download): Promise<T> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString())
}

async function savedReview(page: Page): Promise<ReviewDocument> {
  return page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!), sampleReview.id)
}

async function savedDrafts(page: Page): Promise<CommentDraft[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!))
}

async function savedHistory(page: Page): Promise<ReviewRecord[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:record-history')!))
}

async function importReview(page: Page, review: ReviewDocument) {
  const closeStatus = page.getByRole('button', { name: '关闭状态提示', exact: true })
  if (await closeStatus.count()) await closeStatus.click()
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  await expect(page.getByText('评审已导入，原批注与各版本草稿均保留。', { exact: true })).toBeVisible()
}

async function saveScopeComment(page: Page, scope: 'scene' | 'review', body: string) {
  await commentScope(page, scope)
  const editor = page.getByRole('dialog', { name: '流程批注', exact: true })
  await editor.getByLabel('问题与预期行为').fill(body)
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(editor).not.toBeVisible()
}

async function openComments(page: Page, count: number) {
  await openInspector(page, 'comments')
  await expect(page.locator('.inspector .comment-card')).toHaveCount(count)
}

test('scene and review anchors survive a new revision while old drafts remain exportable', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: sampleReview.title, exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/layout-desktop.png' })
  await saveScopeComment(page, 'scene', '此场景还缺少失败流程。')
  await saveScopeComment(page, 'review', '整个评审需要说明覆盖边界。')
  expect((await savedReview(page)).comments.map(comment => comment.targets)).toEqual([
    [{ kind: 'scene', id: 'upgrade' }], [{ kind: 'review', id: sampleReview.id }],
  ])
  await page.locator('.react-flow__node[data-id="upgrade-start"]').hover()
  await page.getByRole('button', { name: '批注：发起总等级升级', exact: true }).click()
  await page.getByLabel('问题与预期行为').fill('属于旧源码版本的未完成意见。')
  await page.getByRole('button', { name: '关闭编辑器并保留草稿', exact: true }).click()
  const oldDraft = (await savedDrafts(page))[0]
  const next = structuredClone(sampleReview)
  next.revision = 'review-v2'
  next.snapshot.fingerprint = 'source-v2'
  next.nodes[0].summary = '新版本：升级入口已核对。'
  await importReview(page, next)
  await expectRevision(page, 'review-v2')
  const rebased = await savedReview(page)
  expect(rebased.comments.map(comment => comment.status)).toEqual(['needs-review', 'needs-review'])
  await openInspector(page, 'drafts')
  const draft = page.locator('.draft-list .draft-entry')
  await expect(draft).toContainText('旧版本或原目标不可用')
  await expect(draft.getByRole('button', { name: '继续编辑', exact: true })).toHaveCount(0)
  const exported = page.waitForEvent('download')
  await draft.locator('.draft-options > summary').click()
  await draft.getByRole('button', { name: '导出这份草稿', exact: true }).click()
  expect(await readDownload<CommentDraft>(await exported)).toEqual(oldDraft)
  await page.reload()
  expect(await savedDrafts(page)).toEqual([oldDraft])
  await openComments(page, 2)
  await expect(page.getByRole('article', { name: '意见 1', exact: true }).locator('.status-label')).toContainText('待复核')
  await page.locator('.scene-button').filter({ hasText: '解锁新技能' }).click()
  await expect(page.getByRole('heading', { name: '解锁新技能', exact: true })).toBeVisible()
  await page.getByRole('article', { name: '意见 1', exact: true }).getByRole('button', { name: '场景 · 升级总等级', exact: true }).click()
  await expect(page.getByRole('heading', { name: '升级总等级', exact: true })).toBeVisible()
  await page.getByRole('article', { name: '意见 1', exact: true }).getByRole('button', { name: '复核并确认解决', exact: true }).click()
  expect((await savedReview(page)).comments[0]).toMatchObject({ status: 'resolved', revision: sampleReview.revision, reviewedRevision: 'review-v2' })
  expect(errors).toEqual([])
})

test('feedback packages freeze a snapshot, deduplicate submissions, and offer both draft choices', async ({ page }) => {
  await page.goto('/')
  await saveScopeComment(page, 'scene', '已保存的场景意见。')
  await commentScope(page, 'review')
  await page.getByLabel('问题与预期行为').fill('暂留在草稿的整轮意见。')
  await page.getByRole('button', { name: '关闭编辑器并保留草稿', exact: true }).click()
  await page.locator('.topbar').getByRole('button', { name: '提交本轮（1）', exact: true }).click()
  const summary = page.getByRole('region', { name: '提交本轮意见', exact: true })
  await expect(summary).toContainText('1 条新意见 · 1 份本版本草稿')
  await expect(summary.getByRole('button', { name: '保存草稿并提交', exact: true })).toBeEnabled()
  const firstDownload = page.waitForEvent('download')
  await summary.getByRole('button', { name: '仅提交已保存意见', exact: true }).click()
  const firstPackage = await readDownload<ReviewRecord>(await firstDownload)
  expect(firstPackage.kind).toBe('logic-margin-feedback')
  expect(firstPackage.review.snapshot).toEqual(sampleReview.snapshot)
  expect(firstPackage.review.comments.map(comment => comment.body)).toEqual(['已保存的场景意见。'])
  expect(firstPackage.review.comments[0].status).toBe('open')
  expect((await savedDrafts(page)).map(draft => draft.body)).toEqual(['暂留在草稿的整轮意见。'])
  await expect(page.getByText('意见包已生成，待交给代理。文件包含本轮意见与固定流程快照。', { exact: true })).toBeVisible()
  await page.locator('.topbar').getByRole('button', { name: '查看待处理意见', exact: true }).click()
  await expect(summary).not.toBeVisible()
  await expect(page.getByRole('article', { name: '意见 1', exact: true })).toHaveClass(/is-active/)
  expect(await savedHistory(page)).toEqual([firstPackage])
  await openInspector(page, 'drafts')
  await page.locator('.draft-list .draft-entry').getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  await page.locator('.topbar').getByRole('button', { name: '提交本轮（1）', exact: true }).click()
  const secondDownload = page.waitForEvent('download')
  await summary.getByRole('button', { name: '生成意见包', exact: true }).click()
  const secondPackage = await readDownload<ReviewRecord>(await secondDownload)
  expect(secondPackage.review.comments.map(comment => comment.body)).toEqual(['暂留在草稿的整轮意见。'])
  expect(secondPackage.id).not.toBe(firstPackage.id)
  expect(await savedDrafts(page)).toEqual([])
  expect((await savedReview(page)).comments).toHaveLength(2)
  expect(await savedHistory(page)).toEqual([firstPackage, secondPackage])
  await page.locator('.topbar').getByRole('button', { name: '查看待处理意见', exact: true }).click()
  await expect(summary).not.toBeVisible()
  expect(await savedHistory(page)).toEqual([firstPackage, secondPackage])
  await page.reload()
  await page.locator('.topbar').getByRole('button', { name: '查看待处理意见', exact: true }).click()
  await expect(summary).not.toBeVisible()
  expect(await savedHistory(page)).toEqual([firstPackage, secondPackage])
  await openComments(page, 2)
  await page.getByRole('button', { name: '退出连续复核', exact: true }).click()
  await page.getByRole('article', { name: '意见 1', exact: true }).getByRole('button', { name: '确认解决', exact: true }).click()
  expect((await savedReview(page)).comments[0].status).toBe('resolved')
  expect((await savedHistory(page))[0]).toEqual(firstPackage)
  await page.locator('.record-list').getByText('本地评审记录 · 2', { exact: true }).click()
  const fixedDownload = page.waitForEvent('download')
  await page.locator('.record-list .draft-entry').last().getByRole('button', { name: '下载固定记录', exact: true }).click()
  expect(await readDownload<ReviewRecord>(await fixedDownload)).toEqual(firstPackage)
  for (let count = 0; count < 2; count++) {
    const closeStatus = page.getByRole('button', { name: '关闭状态提示', exact: true })
    if (await closeStatus.count()) await closeStatus.click()
    await page.getByLabel('导入评审文件').setInputFiles({ name: 'fixed-record.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(firstPackage)) })
    await expect(page.getByText('固定版本记录已导入历史，当前流程保持原版本。', { exact: true })).toBeVisible()
  }
  expect(await savedHistory(page)).toEqual([firstPackage, secondPackage])
  expect((await savedReview(page)).comments[0].status).toBe('resolved')
  const archiveDownload = page.waitForEvent('download')
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '导出并归档全部历史', exact: true }).click()
  const archive = await readDownload<ReviewRecord[]>(await archiveDownload)
  expect(archive).toEqual([firstPackage, secondPackage])
  expect(await savedHistory(page)).toEqual([])
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(page.getByText('固定版本记录已恢复到本地历史。', { exact: true })).toBeVisible()
  expect(await savedHistory(page)).toEqual(archive)
  await expect(page.locator('.topbar').getByRole('button', { name: '查看待处理意见', exact: true })).toBeEnabled()
})

test('reviewer replies and repeated agent imports lead to human re-review and a separate approval record', async ({ page }) => {
  await page.goto('/')
  await saveScopeComment(page, 'scene', '核对失败出口。')
  await saveScopeComment(page, 'review', '核对整个评审范围。')
  await openComments(page, 2)
  const firstCard = page.getByRole('article', { name: '意见 1', exact: true })
  const secondCard = page.getByRole('article', { name: '意见 2', exact: true })
  await firstCard.getByRole('button', { name: '回复讨论', exact: true }).click()
  const replyEditor = page.getByRole('dialog', { name: '回复讨论', exact: true })
  await replyEditor.getByLabel('补充说明').fill('请保留拒绝分支的状态说明。')
  await replyEditor.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(firstCard.locator('.reply-card')).toContainText('评审补充')
  expect((await savedReview(page)).comments[0].status).toBe('open')
  const response = await savedReview(page)
  response.comments.forEach((comment, index) => {
    comment.status = 'resolved'
    comment.replies = [...(comment.replies ?? []), { id: `agent-response-${index}`, author: 'agent', body: `代理已补充第 ${index + 1} 项依据。`, createdAt: '2026-11-02T16:00:00Z', revision: response.revision }]
  })
  await importReview(page, response)
  await importReview(page, response)
  const imported = await savedReview(page)
  expect(imported.comments.map(comment => comment.status)).toEqual(['needs-review', 'needs-review'])
  expect(imported.comments.map(comment => comment.replies?.length)).toEqual([2, 1])
  await openComments(page, 2)
  await expect(firstCard.locator('.reply-card')).toHaveCount(2)
  await expect(secondCard.locator('.reply-card')).toHaveCount(1)
  await expect(page.locator('.topbar').getByRole('button', { name: '复核本轮', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '确认整轮通过', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '开始逐条复核', exact: true }).click()
  await expect(firstCard).toHaveClass(/is-active/)
  await firstCard.getByRole('button', { name: '仍需处理并下一条', exact: true }).click()
  await expect(secondCard).toHaveClass(/is-active/)
  expect((await savedReview(page)).comments.map(comment => comment.status)).toEqual(['open', 'needs-review'])
  await secondCard.getByRole('button', { name: '仍需处理并下一条', exact: true }).click()
  expect((await savedReview(page)).comments.map(comment => comment.status)).toEqual(['open', 'open'])
  await expect(page.getByRole('button', { name: '退出连续复核', exact: true })).toHaveCount(0)
  await expect(page.getByText('本轮意见已逐条复核，仍需处理的意见已保留。', { exact: true })).toBeVisible()
  await expect(page.locator('.topbar').getByRole('button', { name: '完成审查', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认整轮通过', exact: true })).toHaveCount(0)
  await firstCard.getByRole('button', { name: '确认解决', exact: true }).click()
  await secondCard.getByRole('button', { name: '确认解决', exact: true }).click()
  expect(await savedHistory(page)).toEqual([])
  await page.locator('.topbar').getByRole('button', { name: '完成审查', exact: true }).click()
  const confirmation = page.getByRole('region', { name: '完成审查', exact: true })
  await expect(confirmation.getByRole('button', { name: '确认整轮通过', exact: true })).toBeEnabled()
  const approvalDownload = page.waitForEvent('download')
  await confirmation.getByRole('button', { name: '确认整轮通过', exact: true }).click()
  const approval = await readDownload<ReviewRecord>(await approvalDownload)
  expect(approval.kind).toBe('logic-margin-approval')
  expect(approval.review.comments.every(comment => comment.status === 'resolved')).toBe(true)
  expect(approval.review.snapshot).toEqual(sampleReview.snapshot)
  await expect(page.locator('.topbar-actions').getByText('本轮已通过', { exact: true })).toBeVisible()
  await importReview(page, response)
  expect((await savedReview(page)).comments.map(comment => comment.status)).toEqual(['resolved', 'resolved'])
  expect((await savedReview(page)).comments.map(comment => comment.replies?.length)).toEqual([2, 1])
  expect(await savedHistory(page)).toEqual([approval])
  await page.reload()
  await openComments(page, 2)
  await expect(page.locator('.topbar-actions').getByText('本轮已通过', { exact: true })).toBeVisible()
})

test('invalid imports preserve the review and damaged review and draft storage require separate backups', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":99}') })
  await expect(page.getByRole('alert')).toContainText('导入失败')
  await expect(page.getByRole('heading', { name: sampleReview.title, exact: true })).toBeVisible()
  await page.evaluate(id => {
    localStorage.setItem(`logic-margin:review:${id}`, '{broken')
    localStorage.setItem('logic-margin:drafts', '{broken-drafts')
  }, sampleReview.id)
  await page.reload()
  await expect(page.locator('.save-state')).toContainText('保存已暂停')
  expect(await page.evaluate(id => localStorage.getItem(`logic-margin:review:${id}`), sampleReview.id)).toBe('{broken')
  expect(await page.evaluate(() => localStorage.getItem('logic-margin:drafts'))).toBe('{broken-drafts')
  const reviewBackup = page.waitForEvent('download')
  await page.getByRole('button', { name: '备份原记录并启用保存', exact: true }).click()
  expect((await reviewBackup).suggestedFilename()).toBe('logic-margin-review-recovery.txt')
  await expect(page.locator('.save-state')).toContainText('已保存到本机')
  expect(await page.evaluate(() => localStorage.getItem('logic-margin:drafts'))).toBe('{broken-drafts')
  const draftBackup = page.waitForEvent('download')
  await page.getByRole('button', { name: '备份草稿原记录并启用保存', exact: true }).click()
  expect((await draftBackup).suggestedFilename()).toBe('logic-margin-drafts-recovery.txt')
  expect(await savedDrafts(page)).toEqual([])
})

test('mobile storage failures stay visible while in-memory drafts and comments can be exported', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') }
  })
  await page.goto('/')
  await expect(page.getByText('本地保存失败，请导出', { exact: true })).toBeVisible()
  await expect(page.getByText('草稿保存失败，请导出草稿后再离开。', { exact: true })).toBeVisible()
  await commentScope(page, 'scene')
  await page.getByLabel('问题与预期行为').fill('存储空间不足时也要能导出这份意见。')
  const draftDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出草稿', exact: true }).click()
  const drafts = await readDownload<CommentDraft[]>(await draftDownload)
  expect(drafts[0].body).toBe('存储空间不足时也要能导出这份意见。')
  await commentScope(page, 'scene')
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  const exported = page.waitForEvent('download')
  await exportReview(page)
  expect((await readDownload<ReviewDocument>(await exported)).comments[0].body).toBe(drafts[0].body)
})

for (const width of [320, 375, 414, 768]) {
  test(`tool layout stays usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(page.locator('.file-menu > summary')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const button of await page.locator('.topbar button:visible').all()) {
      const bounds = await button.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    }
    if (width < 700) {
      await page.getByLabel('场景', { exact: true }).selectOption('unlock')
      await expect(page.getByLabel('场景', { exact: true })).toHaveValue('unlock')
    }
    if (width === 320) await page.screenshot({ path: 'test-results/layout-mobile.png', fullPage: true })
  })
}
