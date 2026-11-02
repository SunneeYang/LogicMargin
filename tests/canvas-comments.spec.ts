import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'
import type { CommentDraft, ReviewDocument } from '../src/types.ts'

const firstNode = '.react-flow__node[data-id="upgrade-start"]'
const secondNode = '.react-flow__node[data-id="upgrade-toggle"]'
const composer = (page: Page) => page.getByRole('dialog', { name: '流程批注', exact: true })

async function openFirstComposer(page: Page) {
  await page.locator(firstNode).hover()
  await page.getByRole('button', { name: '批注：发起总等级升级', exact: true }).click()
  await expect(composer(page)).toBeVisible()
}

async function savedReview(page: Page): Promise<ReviewDocument> {
  return page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!), sampleReview.id)
}

async function savedDrafts(page: Page): Promise<CommentDraft[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!))
}

test('save on the diagram, read the marker in the sidebar, and restore after reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await openFirstComposer(page)
  const editor = composer(page)
  await expect(editor).toHaveAttribute('aria-modal', 'false')
  await expect(editor.getByLabel('问题与预期行为')).toBeFocused()
  await expect(editor.locator('.composer-targets')).toHaveText('发起总等级升级')
  await editor.getByLabel('问题与预期行为').fill('这里不应该要求已有上阵技能。')
  await page.screenshot({ path: 'test-results/canvas-comment-dark.png' })
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const marker = page.getByRole('button', { name: '批注：发起总等级升级（1 条）', exact: true })
  await expect(marker).toBeFocused()
  await marker.click()
  await expect(page.locator('.inspector.is-open .comment-body')).toHaveText('这里不应该要求已有上阵技能。')
  await expect(editor).not.toBeVisible()
  await page.reload()
  await marker.click()
  await expect(page.locator('.inspector.is-open .comment-body')).toHaveText('这里不应该要求已有上阵技能。')
  expect((await savedReview(page)).comments[0].targets).toEqual([{ kind: 'node', id: 'upgrade-start' }])
  expect(await savedDrafts(page)).toEqual([])
  expect(errors).toEqual([])
})

test('one editor keeps its DOM, caret, body, and frozen targets across docking and draft recovery', async ({ page }) => {
  await page.goto('/')
  await openFirstComposer(page)
  const editor = composer(page)
  const input = editor.getByLabel('问题与预期行为')
  const body = '先保留这段尚未完成的评审意见。'
  await input.fill(body)
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.dataset.editorIdentity = 'original'
    element.setSelectionRange(2, 6)
  })
  await editor.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
  await expect(editor).toHaveClass(/is-docked/)
  await expect(input).toHaveAttribute('data-editor-identity', 'original')
  await expect(input).toBeFocused()
  expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 6])
  await page.locator(secondNode).locator('.node-title').click()
  await expect(page.locator(secondNode)).toHaveClass(/selected/)
  await expect(editor.locator('.composer-targets')).toHaveText('发起总等级升级')
  await expect(input).toHaveValue(body)
  expect((await savedDrafts(page))[0].targets).toEqual([{ kind: 'node', id: 'upgrade-start' }])
  await editor.getByRole('button', { name: '返回图内编辑', exact: true }).click()
  await expect(editor).toHaveClass(/is-inline/)
  await expect(input).toHaveAttribute('data-editor-identity', 'original')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  await openFirstComposer(page)
  await expect(input).toHaveValue(body)
  await page.getByRole('button', { name: '浏览', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.reload()
  await openFirstComposer(page)
  await expect(input).toHaveValue(body)
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
  await expect(editor).toBeVisible()
  expect((await savedReview(page)).comments).toHaveLength(0)
  await input.press('Control+Enter')
  await expect(editor).not.toBeVisible()
  const saved = await savedReview(page)
  expect(saved.comments).toHaveLength(1)
  expect(saved.comments[0]).toMatchObject({ body, targets: [{ kind: 'node', id: 'upgrade-start' }] })
  expect(await savedDrafts(page)).toEqual([])
})

test('marquee selects only nodes, an explicit edge joins the selection, and the group gets one marker', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '框选', exact: true }).click()
  const one = await page.locator(firstNode).boundingBox()
  const two = await page.locator(secondNode).boundingBox()
  await page.mouse.move(one!.x - 8, one!.y - 8)
  await page.mouse.down()
  await page.mouse.move(two!.x + two!.width + 8, two!.y + two!.height + 8, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '批注所选（2）', exact: true })).toBeVisible()
  await page.getByRole('group', { name: '发起总等级升级：提交', exact: true }).click({ modifiers: ['Shift'] })
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1)
  await page.getByRole('button', { name: '批注所选（3）', exact: true }).click()
  const editor = composer(page)
  await expect(editor.locator('.composer-targets')).toContainText('所选 3 项')
  await editor.getByLabel('问题与预期行为').fill('这段流程失败时不能扣除资源。')
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(editor).not.toBeVisible()
  expect((await savedReview(page)).comments[0].targets).toEqual([
    { kind: 'node', id: 'upgrade-start' }, { kind: 'node', id: 'upgrade-toggle' },
    { kind: 'edge', id: 'upgrade-start-to-toggle' },
  ])
  await page.getByRole('button', { name: '批注 1，涉及 3 项', exact: true }).click()
  await expect(page.locator('.inspector.is-open .comment-body')).toHaveText('这段流程失败时不能扣除资源。')
})

test('right-clicking a success edge anchors a comment to that exact edge', async ({ page }) => {
  await page.goto('/')
  const edge = page.getByRole('group', { name: '通灵功能是否开放？：开放', exact: true })
  await edge.click({ button: 'right' })
  const editor = composer(page)
  await expect(editor).toBeVisible()
  await expect(editor.locator('.composer-targets')).toHaveText('连线 · 开放')
  await editor.getByLabel('问题与预期行为').fill('只允许功能开放时继续。')
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(edge).toContainText('有批注')
  expect((await savedReview(page)).comments[0].targets).toEqual([{ kind: 'edge', id: 'upgrade-toggle-to-level' }])
})

test('mobile editing stays reachable, preserves text through resize, and follows system appearance', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await openFirstComposer(page)
  const editor = composer(page)
  await expect(editor.getByLabel('问题与预期行为')).not.toBeFocused()
  await editor.scrollIntoViewIfNeeded()
  const bounds = await editor.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  await editor.getByLabel('问题与预期行为').fill('手机上直接留下的意见')
  await page.setViewportSize({ width: 375, height: 620 })
  await editor.getByRole('button', { name: '添加批注', exact: true }).scrollIntoViewIfNeeded()
  await expect(editor.getByRole('button', { name: '添加批注', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const dark = await editor.evaluate(element => getComputedStyle(element).backgroundColor)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => editor.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(dark)
  await expect(editor.getByLabel('问题与预期行为')).toHaveValue('手机上直接留下的意见')
  await page.setViewportSize({ width: 375, height: 900 })
  await page.screenshot({ path: 'test-results/canvas-comment-mobile.png' })
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(editor).not.toBeVisible()
  expect((await savedReview(page)).comments[0].body).toBe('手机上直接留下的意见')
})
