import { sourceExampleURL } from './ui.ts'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { commentScope, openInspector } from './ui.ts'

test.use({ baseURL: sourceExampleURL })

const requirementTitle = '虚构演示 · 任务流水线'

async function viewport(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { zoom: matrix.a, x: matrix.e, y: matrix.f }
  })
}

async function visibleCanvas(page: Page) {
  return page.locator('.canvas').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      visibleHeight: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)),
      viewportHeight: innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    }
  })
}

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`expanded navigation leaves a full-height canvas at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/?review=task-pipeline')
    await expect(page.getByRole('heading', { name: requirementTitle, exact: true })).toBeVisible()
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.getByRole('button', { name: '收起场景导航', exact: true })).toBeVisible()
    const original = await visibleCanvas(page)
    expect(original.visibleHeight).toBeGreaterThanOrEqual(height - 130)
    expect(original.top).toBeGreaterThanOrEqual(0)
    expect(original.bottom).toBeLessThanOrEqual(height + 1)
    expect(original.pageHeight).toBeLessThanOrEqual(height + 1)
    expect(original.pageWidth).toBeLessThanOrEqual(width)
    await openInspector(page, 'detail')
    const withDetails = await visibleCanvas(page)
    expect(withDetails.visibleHeight).toBeGreaterThanOrEqual(height - 130)
    expect(withDetails.height).toBeCloseTo(original.height, 0)
    expect(withDetails.width).toBeLessThan(original.width)
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    const restored = await visibleCanvas(page)
    expect(restored.width).toBeCloseTo(original.width, 0)
  })
}

test('collapsing navigation, opening details, and focus mode retain the zoom and reading position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?review=task-pipeline')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.react-flow__node[data-id="enter-request"]')).toBeVisible()
  const initial = await viewport(page)
  await page.getByRole('button', { name: '放大流程', exact: true }).click()
  await expect.poll(async () => Math.round((await viewport(page)).zoom * 1000)).toBe(Math.round(initial.zoom * 1.2 * 1000))
  const canvas = await page.locator('.canvas').boundingBox()
  await page.mouse.move(canvas!.x + 24, canvas!.y + 220)
  await page.mouse.down()
  await page.mouse.move(canvas!.x + 54, canvas!.y + 70, { steps: 10 })
  await page.mouse.up()
  const reading = await viewport(page)
  expect(reading.y).toBeLessThan(initial.y - 80)
  await page.getByRole('button', { name: '收起场景导航', exact: true }).click()
  await expect(page.locator('.sidebar')).not.toBeVisible()
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(reading.zoom, 3)
  await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(reading.y, 0)
  await openInspector(page, 'detail')
  await expect(page.locator('.inspector.is-open')).toBeVisible()
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(reading.zoom, 3)
  await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(reading.y, 0)
  await page.getByRole('button', { name: '专注画布', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出专注', exact: true })).toBeVisible()
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(reading.zoom, 3)
  await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(reading.y, 0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '专注画布', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '展开场景导航', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
})

test('Escape closes an active composer before leaving focus and keeps its anchored draft', async ({ page }) => {
  await page.goto('/?review=task-pipeline')
  await expect(page.getByRole('heading', { name: requirementTitle, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '专注画布', exact: true }).click()
  await page.locator('.react-flow__node[data-id="enter-request"]').click({ button: 'right' })
  const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await editor.getByLabel('问题与预期行为').fill('专注阅读时仍要保留固定对象的草稿。')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  await expect(page.getByRole('button', { name: '退出专注', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '专注画布', exact: true })).toBeVisible()
  await page.locator('.react-flow__node[data-id="enter-request"]').click({ button: 'right' })
  await expect(editor.getByLabel('问题与预期行为')).toHaveValue('专注阅读时仍要保留固定对象的草稿。')
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!)[0])
  expect(draft.targets).toEqual([{ kind: 'node', id: 'enter-request' }])
})

for (const width of [320, 375, 414, 768]) {
  test(`small-screen scene navigation and bottom editor stay inside ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 })
    await page.goto('/?review=task-pipeline')
    await expect(page.getByRole('heading', { name: requirementTitle, exact: true })).toBeVisible()
    const initial = await visibleCanvas(page)
    expect(initial.visibleHeight).toBeGreaterThanOrEqual(570)
    expect(initial.bottom).toBeLessThanOrEqual(813)
    expect(initial.pageWidth).toBeLessThanOrEqual(width)
    await page.getByRole('button', { name: '展开场景导航', exact: true }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.locator('.sidebar .scene-button').filter({ hasText: '重试历史任务' }).click()
    await expect(page.locator('.scene-title')).toHaveText('重试历史任务')
    await expect(page.locator('.sidebar')).not.toBeVisible()
    await commentScope(page, 'scene')
    const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
    await expect(editor.getByLabel('问题与预期行为')).not.toBeFocused()
    await editor.getByLabel('问题与预期行为').fill('小屏幕内也能保存对扫荡逻辑的意见。')
    const editorBounds = await editor.boundingBox()
    expect(editorBounds!.x).toBeGreaterThanOrEqual(0)
    expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(width)
    await expect(editor.getByRole('button', { name: '添加批注', exact: true })).toBeInViewport()
    await editor.getByRole('button', { name: '添加批注', exact: true }).click()
    await expect(editor.getByLabel('问题与预期行为')).toHaveCount(0)
    await editor.getByRole('button', { name: '关闭讨论', exact: true }).click()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect(page.getByRole('button', { name: /^评审面板/ })).toBeInViewport({ ratio: 1 })
      await openInspector(page, 'comments')
      const inspector = await page.locator('.inspector.is-open').boundingBox()
      expect(inspector!.x).toBeGreaterThanOrEqual(0)
      expect(inspector!.x + inspector!.width).toBeLessThanOrEqual(width)
      expect(inspector!.y + inspector!.height).toBeLessThanOrEqual(813)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    }
    expect((await visibleCanvas(page)).height).toBeCloseTo(initial.height, 0)
  })
}
