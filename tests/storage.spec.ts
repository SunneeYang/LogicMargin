import { test, expect } from '@playwright/test'
import { commentScope } from './ui.ts'
import { sampleReview } from '../src/sample.ts'
import { createFeedbackPackage, makeDraft } from '../src/workspace.ts'
import { addComment } from '../src/model.ts'

test('draft capacity blocks a new editor before input and an existing draft can be exported and released', async ({ page }) => {
  const drafts = Array.from({ length: 200 }, (_, index) => makeDraft({ ...sampleReview, revision: `old-${index}` }, [{ kind: 'review', id: sampleReview.id }], `保留意见 ${index}`))
  await page.addInitScript(value => localStorage.setItem('logic-margin:drafts', JSON.stringify(value)), drafts)
  await page.goto('/')
  await commentScope(page, 'scene')
  await expect(page.getByRole('alert')).toContainText('200 份上限')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '草稿 200', exact: true }).first().click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出并移除草稿', exact: true }).first().click()
  await download
  await expect(page.getByRole('heading', { name: '保留的草稿 · 199', exact: true })).toBeVisible()
  await commentScope(page, 'scene')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('问题与预期行为').fill('容量释放后保留的新意见')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!).length)).toBe(200)
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
