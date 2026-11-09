import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { addComment, addReply } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import { readContrastPairs } from './contrast.ts'

async function openReview(page: Page) {
  await page.goto('/')
  let review = addComment(structuredClone(sampleReview), [{ kind: 'node', id: 'upgrade-toggle' }], '关闭功能时，是否仍会扣除升级资源？')
  review = addReply(review, review.comments[0].id, '请核对功能开关、等级配置和消耗校验的先后顺序。失败出口需要保留原资源。')
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'themes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '讨论：通灵功能是否开放？（1 条）', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '节点讨论', exact: true })).toBeVisible()
}

async function chooseTheme(page: Page, theme: string, mode: string) {
  await page.getByLabel('设置', { exact: true }).click()
  await page.getByLabel('界面主题', { exact: true }).selectOption(theme)
  await page.locator(`#appearance-mode button[value="${mode}"]`).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  if (mode !== 'system') await expect(page.locator('html')).toHaveAttribute('data-mode', mode)
}

const textPairs = [
  ['.review-title', '.topbar'], ['.scene-title', '.graph-toolbar'],
  ['.navigation-heading', '.sidebar'], ['.scene-button.active', '.scene-button.active'],
  ['.react-flow__node.selected .node-title', '.react-flow__node.selected .review-node'],
  ['.react-flow__node.selected .node-summary', '.react-flow__node.selected .review-node'],
  ['.review-node.kind-action .node-summary', '.review-node.kind-action'],
  ['.discussion-target', '.comment-composer'], ['.discussion-context', '.comment-composer'],
  ['.discussion-threads .comment-body', '.comment-composer'], ['.reply-card p', '.comment-composer'],
  ['.comment-composer textarea', '.comment-composer textarea'], ['.composer-hint', '.comment-composer'],
  ['.discussion-threads .status-label', '.comment-composer'],
  ['.node-comment-button:not(.is-empty)', '.node-comment-button:not(.is-empty)'],
  ['.topbar .button.primary', '.topbar .button.primary'],
]

for (const theme of ['paper', 'soft', 'glass']) for (const mode of ['light', 'dark']) {
  test(`${theme} ${mode} preserves review context and readable material on desktop and phone`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openReview(page)
    await page.locator('[data-composer] .comment-card').last().getByRole('button', { name: '回复讨论', exact: true }).click()
    const input = page.getByLabel('补充说明', { exact: true })
    await input.fill('主题切换时保留这份回复草稿。')
    const camera = await page.locator('.react-flow__viewport').getAttribute('style')
    await chooseTheme(page, theme, mode)
    await expect(input).toHaveValue('主题切换时保留这份回复草稿。')
    await expect(page.locator('.discussion-target')).toContainText('通灵功能是否开放？')
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', camera!)
    const contrast = await page.evaluate(readContrastPairs, textPairs)
    for (const pair of contrast) expect.soft(pair.value, `${theme} ${mode} ${pair.selector}`).toBeGreaterThanOrEqual(4.5)
    const boundaries = await page.evaluate(readContrastPairs, [
      ['.comment-composer textarea', '.comment-composer textarea', 'border-top-color'],
      ['.comment-composer textarea', '.comment-composer', 'border-top-color'],
      ['.react-flow__edge:not(.is-related) .react-flow__edge-path', '.canvas', 'stroke'],
      ['.react-flow__edge.is-related .react-flow__edge-path', '.canvas', 'stroke'],
    ])
    for (const pair of boundaries) expect.soft(pair.value, `${theme} ${mode} boundary ${pair.selector}`).toBeGreaterThanOrEqual(3)
    await page.getByRole('button', { name: '收起回复', exact: true }).click()
    await page.screenshot({ path: info.outputPath(`${theme}-${mode}-desktop.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[data-composer] .comment-card').last().getByRole('button', { name: '回复讨论', exact: true })).toBeInViewport({ ratio: 1 })
    await expect.poll(() => page.evaluate(() => {
      const target = document.querySelector('.react-flow__node[data-id="upgrade-toggle"] .review-node')!.getBoundingClientRect()
      const canvas = document.querySelector('.canvas')!.getBoundingClientRect()
      const discussion = document.querySelector('[data-composer]')!.getBoundingClientRect()
      return target.top >= canvas.top && target.bottom <= discussion.top - 4
    })).toBe(true)
    await page.screenshot({ path: info.outputPath(`${theme}-${mode}-phone.png`) })
    await page.locator('[data-composer] .comment-card').last().getByRole('button', { name: '回复讨论', exact: true }).click()
    await expect(input).toHaveValue('主题切换时保留这份回复草稿。')
    await page.setViewportSize({ width: 320, height: 500 })
    await expect(page.getByRole('button', { name: '保存回复', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: '关闭讨论', exact: true })).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode)
    expect(errors).toEqual([])
  })
}

test('explicit selection follows the node and replays a bounded flow while retaining the original reply draft', async ({ page }) => {
  await openReview(page)
  await page.locator('[data-composer] .comment-card').last().getByRole('button', { name: '回复讨论', exact: true }).click()
  await page.getByLabel('补充说明', { exact: true }).fill('仍在回复原节点。')
  const node = page.locator('.react-flow__node[data-id="upgrade-start"]')
  await node.locator('.node-title').click()
  await expect(node).toHaveClass(/selected/)
  await expect(page.locator('.discussion-target')).toContainText('发起总等级升级')
  await expect(page.getByLabel('补充说明', { exact: true })).toHaveCount(0)
  await expect(node).toBeFocused()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!)[0].body)).toBe('仍在回复原节点。')
  const light = page.locator('.edge-flow-light').first()
  await expect(light).toHaveCSS('animation-iteration-count', '2')
  await expect.poll(() => light.evaluate(element => element.getAnimations()[0]?.playState)).toBe('finished')
  await expect(light).toHaveCSS('opacity', '0')
  await expect(page.locator('.react-flow__edge.is-related')).toHaveCount(1)
  await node.locator('.node-title').click()
  await expect.poll(() => light.evaluate(element => element.getAnimations()[0]?.playState)).toBe('running')
  await page.locator('.discussion-target').hover()
  await expect(page.locator('.edge-flow-light')).toHaveCount(0)
  await node.hover()
  await expect(page.locator('.edge-flow-light')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '节点讨论', exact: true })).not.toBeVisible()
  await node.hover()
  await expect.poll(() => light.evaluate(element => element.getAnimations()[0]?.playState)).toBe('running')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.edge-flow-light')).toHaveCount(0)
  await node.locator('.node-title').click()
  await expect(light).toHaveCSS('animation-name', 'none')
  await expect(light).toHaveCSS('opacity', '0')
  await expect(node.locator('.review-node')).toHaveCSS('transform', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await node.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => light.evaluate(element => element.getAnimations()[0]?.playState)).toBe('running')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('.edge-flow-light')).toHaveCount(0)
  await page.evaluate(() => { delete (document as { hidden?: boolean }).hidden })
  await node.locator('.node-title').click()
  await expect.poll(() => light.evaluate(element => element.getAnimations()[0]?.playState)).toBe('running')
  await page.getByRole('button', { name: /解锁新技能.*8 个步骤/ }).click()
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.edge-flow-light')).toHaveCount(0)
  await page.locator('.react-flow__node').first().focus()
  await page.keyboard.press(' ')
  await expect(page.locator('.react-flow__node').first()).toHaveClass(/selected/)
  await expect.poll(() => light.evaluate(element => element.getAnimations()[0]?.playState)).toBe('running')
})

test('theme modes follow the system only when requested, and phone scene navigation contains focus', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await chooseTheme(page, 'glass', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
  await chooseTheme(page, 'soft', 'system')
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
  await page.setViewportSize({ width: 390, height: 844 })
  const toggle = page.getByRole('button', { name: '展开场景导航', exact: true })
  await toggle.click()
  const close = page.getByRole('button', { name: '收起场景列表', exact: true })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('.scene-button').last()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(page.locator('.review-main')).not.toHaveAttribute('inert')
})

test('lifted cards keep their actual ports attached and discussion motion can reverse', async ({ page }) => {
  await openReview(page)
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await discussion.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await expect(discussion).not.toBeVisible()
  const node = page.locator('.react-flow__node[data-id="upgrade-start"]')
  await node.hover()
  await expect.poll(() => node.locator('.review-node').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42)).toBe(-5)
  const gap = () => page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('.react-flow__edge[data-id="upgrade-start-to-toggle"] .react-flow__edge-path')!
    const first = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!)
    const last = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!)
    const source = document.querySelector('[data-handleid="source:upgrade-start-to-toggle"]')!.getBoundingClientRect()
    const target = document.querySelector('[data-handleid="target:upgrade-start-to-toggle"]')!.getBoundingClientRect()
    return Math.max(Math.hypot(first.x - source.x - source.width / 2, first.y - source.y - source.height / 2),
      Math.hypot(last.x - target.x - target.width / 2, last.y - target.y - target.height / 2))
  })
  await expect.poll(gap).toBeLessThan(1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(gap).toBeLessThan(1)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const badge = page.getByRole('button', { name: '讨论：通灵功能是否开放？（1 条）', exact: true })
  await badge.click()
  await discussion.evaluate(element => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Discussion must animate on entry')
    animation.pause(); animation.currentTime = 90
  })
  const opacity = await discussion.evaluate(element => Number(getComputedStyle(element).opacity))
  expect(opacity).toBeGreaterThan(0)
  expect(opacity).toBeLessThan(1)
  await page.keyboard.press('Escape')
  const closing = page.locator('[data-composer][data-state="closing"]')
  await closing.evaluate(element => { const animation = element.getAnimations()[0]; animation.pause(); animation.currentTime = 80 })
  await badge.click()
  await expect(discussion).toHaveAttribute('data-state', 'open')
  await expect.poll(() => discussion.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-composer]')).toHaveCount(0)
})
