import { expect, test } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'

const appearanceKey = 'logic-margin:node-appearance'

test('switching node appearance changes whole cards without moving the flow or losing a draft', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const controls = page.getByRole('group', { name: '节点显示方式', exact: true })
  const plain = controls.getByRole('button', { name: '简洁', exact: true })
  const distinct = controls.getByRole('button', { name: '多样式', exact: true })
  await expect(plain).toHaveAttribute('aria-pressed', 'true')
  const selected = page.locator('.react-flow__node[data-id="upgrade-start"]')
  await selected.locator('.node-title').click()
  const canvas = (await page.locator('.canvas').boundingBox())!
  await page.mouse.move(canvas.x + 30, canvas.y + 100)
  await page.mouse.down()
  await page.mouse.move(canvas.x + 60, canvas.y + 140, { steps: 4 })
  await page.mouse.up()
  await selected.getByRole('button', { name: '批注：发起总等级升级', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '流程批注', exact: true })
  const input = editor.getByLabel('问题与预期行为')
  await input.fill('换一种显示方式后继续核对这一步。')
  const before = await page.evaluate(() => ({
    viewport: document.querySelector('.react-flow__viewport')!.getAttribute('style'),
    nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => ({
      id: node.dataset.id, transform: node.style.transform, width: node.clientWidth, height: node.clientHeight,
      selected: node.classList.contains('selected'),
    })),
  }))
  const reviewBefore = await page.evaluate(id => localStorage.getItem(`logic-margin:review:${id}`), sampleReview.id)
  const neutral = await page.locator('.review-node.kind-action').first().evaluate(node => getComputedStyle(node).backgroundColor)
  await distinct.click()
  await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'distinct')
  await expect(distinct).toHaveAttribute('aria-pressed', 'true')
  await expect(plain).toHaveAttribute('aria-pressed', 'false')
  const backgrounds = []
  for (const kind of ['action', 'decision', 'result', 'failure']) {
    const node = page.locator(`.review-node.kind-${kind}`).first()
    await expect(node).not.toHaveCSS('background-color', neutral)
    backgrounds.push(await node.evaluate(element => getComputedStyle(element).backgroundColor))
    await expect(node.locator('.node-kind svg')).toHaveCount(1)
    await expect(node.locator('.node-kind')).not.toBeEmpty()
    await expect(node).toHaveCSS('border-top-style', 'solid')
  }
  expect(new Set(backgrounds).size).toBe(4)
  await expect(editor).toBeVisible()
  await expect(input).toHaveValue('换一种显示方式后继续核对这一步。')
  expect(await page.evaluate(() => ({
    viewport: document.querySelector('.react-flow__viewport')!.getAttribute('style'),
    nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => ({
      id: node.dataset.id, transform: node.style.transform, width: node.clientWidth, height: node.clientHeight,
      selected: node.classList.contains('selected'),
    })),
  }))).toEqual(before)
  expect(await page.evaluate(id => localStorage.getItem(`logic-margin:review:${id}`), sampleReview.id)).toBe(reviewBefore)
  await page.screenshot({ path: info.outputPath('node-appearance-distinct.png') })
  await plain.click()
  await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'plain')
  for (const kind of ['action', 'decision', 'result', 'failure']) {
    await expect(page.locator(`.review-node.kind-${kind}`).first()).toHaveCSS('background-color', neutral)
  }
  await expect(editor).toBeVisible()
  await expect(input).toHaveValue('换一种显示方式后继续核对这一步。')
})

test('the browser remembers both node appearance choices after a reload', async ({ page }) => {
  await page.goto('/')
  const controls = page.getByRole('group', { name: '节点显示方式', exact: true })
  for (const [name, value] of [['多样式', 'distinct'], ['简洁', 'plain']] as const) {
    await controls.getByRole('button', { name, exact: true }).click()
    expect(await page.evaluate(key => localStorage.getItem(key), appearanceKey)).toBe(value)
    await page.reload()
    await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', value)
    await expect(controls.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
})

test('an unknown stored appearance falls back to the existing plain cards', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'unsupported'), appearanceKey)
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'plain')
  await expect(page.getByRole('group', { name: '节点显示方式', exact: true }).getByRole('button', { name: '简洁', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('unavailable preference storage still allows changing the current canvas', async ({ page }) => {
  await page.addInitScript(key => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Preference storage blocked', 'SecurityError')
      return getItem.call(this, name)
    }
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Preference storage blocked', 'SecurityError')
      return setItem.call(this, name, value)
    }
  }, appearanceKey)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'plain')
  await page.getByRole('group', { name: '节点显示方式', exact: true }).getByRole('button', { name: '多样式', exact: true }).click()
  await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'distinct')
  expect(errors).toEqual([])
})

for (const width of [320, 390]) {
  test(`node appearance controls stay reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/')
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await page.locator('.react-flow__node[data-id="upgrade-start"] .node-title').click()
    const settings = page.getByText('显示设置', { exact: true })
    if (await settings.isVisible()) await settings.click()
    const controls = page.getByRole('group', { name: '节点显示方式', exact: true })
    await expect(controls).toBeInViewport({ ratio: 1 })
    await controls.getByRole('button', { name: '多样式', exact: true }).click()
    await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'distinct')
    await page.locator('.canvas-legend > summary').click()
    await expect(page.locator('.canvas-display-options')).toBeInViewport({ ratio: 1 })
    const legend = page.getByLabel('流程图图例', { exact: true })
    const bounds = await legend.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    const lastParagraph = legend.locator(':scope > p').last()
    await lastParagraph.scrollIntoViewIfNeeded()
    await expect(lastParagraph).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.locator('.canvas-legend > summary').focus()
    await page.keyboard.press('Escape')
    await expect(legend).not.toBeVisible()
  })
}
