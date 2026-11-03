import { test, expect } from '@playwright/test'
import { commentScope, openInspector } from './ui.ts'
import { sampleReview } from '../src/sample.ts'
import { createFeedbackPackage, makeDraft } from '../src/workspace.ts'
import { addComment } from '../src/model.ts'

test('more than two hundred drafts remain editable and can be exported without discarding other work', async ({ page }) => {
  const drafts = Array.from({ length: 201 }, (_, index) => makeDraft({ ...sampleReview, revision: `old-${index}` }, [{ kind: 'review', id: sampleReview.id }], `保留意见 ${index}`))
  await page.addInitScript(value => localStorage.setItem('logic-margin:drafts', JSON.stringify(value)), drafts)
  await page.goto('/')
  await commentScope(page, 'scene')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('问题与预期行为').fill('超过旧上限后保留的新意见')
  await page.getByRole('button', { name: '关闭编辑器并保留草稿', exact: true }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!).length)).toBe(202)
  await openInspector(page, 'drafts')
  const download = page.waitForEvent('download')
  const firstDraft = page.locator('.draft-entry').first()
  await firstDraft.locator('.draft-options > summary').click()
  await firstDraft.getByRole('button', { name: '导出并移除草稿', exact: true }).click()
  await download
  await expect(page.locator('.inspector-tabs').getByRole('button', { name: '草稿 201', exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!).some((draft: { body: string }) => draft.body === '超过旧上限后保留的新意见'))).toBe(true)
})

test('corrupt draft storage pauses overwriting until raw backup and retains new text', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('logic-margin:drafts', '{broken-drafts'))
  await page.reload()
  await commentScope(page, 'scene')
  await page.getByLabel('问题与预期行为').fill('备份前继续写的草稿')
  expect(await page.evaluate(() => localStorage.getItem('logic-margin:drafts'))).toBe('{broken-drafts')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '备份草稿原记录并启用保存', exact: true }).click()
  await download
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!)[0].body)).toBe('备份前继续写的草稿')
})

test('conflicting history import reports an error without crashing or replacing current state', async ({ page }) => {
  const review = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], '原意见')
  const record = createFeedbackPackage(review)
  await page.addInitScript(value => localStorage.setItem('logic-margin:record-history', JSON.stringify([value])), record)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  record.review.comments[0].body = '冲突内容'
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'conflict.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(record)) })
  await expect(page.getByRole('alert')).toContainText('冲突')
  await expect(page.getByRole('heading', { name: sampleReview.title, exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:record-history')!)[0].review.comments[0].body)).toBe('原意见')
  expect(errors).toEqual([])
})

test('a history save failure offers the complete record backup rather than an unrelated draft export', async ({ page }) => {
  const review = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], '需要保留的固定意见')
  const record = createFeedbackPackage(review)
  await page.addInitScript(record => {
    localStorage.setItem('logic-margin:record-history', JSON.stringify([record]))
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'logic-margin:record-history') throw new DOMException('History storage full', 'QuotaExceededError')
      return setItem.call(this, key, value)
    }
  }, record)
  await page.goto('/')
  const error = page.getByRole('alert').filter({ hasText: '评审记录保存失败' })
  await expect(error).toBeVisible()
  await expect(error.getByRole('button', { name: '导出草稿', exact: true })).toHaveCount(0)
  const downloading = page.waitForEvent('download')
  await error.getByRole('button', { name: '导出评审记录', exact: true }).click()
  const download = await downloading
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([record])
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:record-history')!))).toEqual([record])
})
