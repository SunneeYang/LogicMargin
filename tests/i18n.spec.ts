import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { closeSettings, openSettings } from './ui.ts'
import { largeCodeReview } from './fixtures/large-code-review.ts'

const demo = JSON.parse(readFileSync(new URL('../docs/examples/order-review.en.logic-margin.json', import.meta.url), 'utf8'))
const storageKey = `logic-margin:review:${demo.id}`

async function openDemo(page: Page) {
  await page.addInitScript(review => {
    if (!localStorage.getItem(`logic-margin:review:${review.id}`)) {
      localStorage.setItem('logic-margin:active', review.id)
      localStorage.setItem(`logic-margin:review:${review.id}`, JSON.stringify(review))
    }
  }, demo)
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
}

async function language(page: Page, value: 'en' | 'zh-CN') {
  const menu = await openSettings(page)
  await menu.locator(`#interface-language button[value="${value}"]`).click()
  await closeSettings(page)
  await expect(page.locator('html')).toHaveAttribute('lang', value)
}

test('switching language retains the current node, draft, review data, and saved preference', async ({ page }) => {
  await openDemo(page)
  const original = await page.evaluate(key => localStorage.getItem(key), storageKey)
  await page.getByRole('button', { name: '讨论：Reserve stock and pay（1 条）', exact: true }).click()
  const window = page.locator('[data-composer][data-state="open"]')
  await window.getByRole('button', { name: '添加新批注', exact: true }).click()
  const body = 'Keep this draft 原文 unchanged.'
  await window.getByRole('textbox').fill(body)
  await language(page, 'en')
  await expect(window.getByRole('textbox')).toHaveValue(body)
  await expect(window.getByRole('tab', { name: 'Details and discussion', exact: true })).toBeVisible()
  await expect(page.locator('.react-flow__node[data-id="payment"]')).toHaveClass(/selected/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(demo.title)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(original)
  await window.getByRole('tab', { name: 'Code diff', exact: true }).click()
  await window.getByRole('button', { name: 'Side by side', exact: true }).click()
  await expect(window.locator('.cm-editor')).toHaveCount(2)
  await window.getByRole('button', { name: 'Expand all', exact: true }).click()
  const editors = await window.locator('.cm-editor').elementHandles()
  await language(page, 'zh-CN')
  for (const editor of editors) expect(await editor.evaluate(element => element.isConnected)).toBe(true)
  await expect(window.getByRole('button', { name: '折叠未变', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(window.getByRole('tab', { name: '代码 diff', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(window.locator('.cm-editor')).toHaveCount(2)
  await language(page, 'en')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!)[0].body)).toBe(body)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(original)
})

test('language changes preserve virtual diff identity, reading position, and manually unfolded code', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: largeCodeReview() } })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '统一', exact: true }).click()
  const editor = panel.locator('.cm-unified-virtual')
  await expect(editor).toBeVisible()
  await editor.evaluate(element => { element.dataset.identity = 'virtual-language' })
  const unfolded = editor.locator('.cm-line').filter({ hasText: /^const item20 = 20;$/ })
  await expect(unfolded).toHaveCount(0)
  await editor.locator('.cm-collapsedLines').first().click()
  await expect(unfolded).toBeVisible()
  await language(page, 'en')
  await expect(editor).toHaveAttribute('data-identity', 'virtual-language')
  await expect(unfolded).toBeVisible()
  const scroller = editor.locator('.cm-scroller')
  await scroller.evaluate(element => { element.scrollTop = 1000 })
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(900)
  await expect(editor.locator('.cm-collapsedLines').first()).toContainText('unchanged lines')
  const reading = await scroller.evaluate(element => element.scrollTop)
  await language(page, 'zh-CN')
  await expect(editor).toHaveAttribute('data-identity', 'virtual-language')
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeCloseTo(reading, 0)
  await expect(editor.locator('.cm-collapsedLines').first()).toContainText('行未修改')
  await scroller.evaluate(element => { element.scrollTop = 0 })
  await expect(unfolded).toBeVisible()
})

test('deferred code comparison placeholders follow the interface language', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: largeCodeReview() } })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="multiple"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '统一', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveCount(1)
  await panel.locator('.code-evidence-section').evaluateAll(elements => {
    for (const element of elements) (element as HTMLDetailsElement).open = true
  })
  const pending = panel.locator('[data-code-layout="pending"] .code-evidence-placeholder').first()
  await expect(pending).toHaveText('正在加载代码对照…')
  await language(page, 'en')
  await expect(pending).toHaveText('Loading code comparison…')
  await language(page, 'zh-CN')
  await expect(pending).toHaveText('正在加载代码对照…')
})

test.describe('English browser preference', () => {
  test.use({ locale: 'en-US' })

  test('uses English for flow, discussion, details, code, and legend while baseline stays original', async ({ page }) => {
    await openDemo(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const before = await page.evaluate(key => localStorage.getItem(key), storageKey)
    await page.getByRole('button', { name: 'Baseline B', exact: true }).click()
    await expect(page.locator('.react-flow__node[data-id="payment"]')).toContainText('Deduct stock and pay')
    await expect(page.locator('.react-flow__node .revision-badge')).toHaveCount(0)
    await page.getByRole('button', { name: 'After', exact: true }).click()
    await page.getByRole('button', { name: 'Discussion: Reserve stock and pay (1)', exact: true }).click()
    const window = page.locator('[data-composer][data-state="open"]')
    for (const tab of ['Details and discussion', 'Code diff']) {
      await window.getByRole('tab', { name: tab, exact: true }).click()
      if (tab === 'Code diff') await expect(window.locator('.cm-editor').first()).toBeVisible()
      expect(await page.locator('body').innerText()).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(before)
  })

  test('import errors translate without replacing the review and can switch back to Chinese', async ({ page }) => {
    await openDemo(page)
    const before = await page.evaluate(key => localStorage.getItem(key), storageKey)
    await page.locator('input[type="file"]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('null') })
    await expect(page.getByRole('alert')).toContainText('Review document must be an object.')
    await language(page, 'zh-CN')
    await expect(page.getByRole('alert')).toContainText('评审文件必须是对象')
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(before)
  })

  for (const mode of ['light', 'dark']) test(`English controls fit a phone viewport in ${mode} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(mode => localStorage.setItem('logic-margin:appearance', JSON.stringify({ theme: 'glass', mode })), mode)
    await openDemo(page)
    await page.getByRole('button', { name: 'Discussion: Submit order', exact: true }).click()
    const window = page.locator('[data-composer][data-state="open"]')
    await expect(window.getByRole('tab')).toHaveText(['Details and discussion', 'Code diff'])
    const combined = window.getByRole('tabpanel', { name: 'Details and discussion', exact: true })
    await expect(combined.locator('.target-details')).toBeVisible()
    await expect(combined.locator('.discussion-threads')).toBeVisible()
    await expect(combined.locator('.evidence')).toHaveCount(0)
    await expect(window.getByRole('tab', { name: 'Code diff', exact: true })).toBeVisible()
    const bounds = await window.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('body').innerText()).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
