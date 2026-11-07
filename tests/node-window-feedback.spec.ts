import { expect, test } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'
import { addComment } from '../src/model.ts'

test('one node entry opens chronological discussions with new comments at the end', async ({ page }) => {
  let review = addComment(structuredClone(sampleReview), [{ kind: 'node', id: 'upgrade-start' }], '最初的批注')
  review = addComment(review, [{ kind: 'node', id: 'upgrade-start' }], '后来的批注')
  await page.addInitScript(review => {
    localStorage.setItem('logic-margin:active', review.id)
    localStorage.setItem(`logic-margin:review:${review.id}`, JSON.stringify(review))
  }, review)
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const node = page.locator('.react-flow__node[data-id="upgrade-start"]')
  await expect(node.getByRole('button')).toHaveCount(1)
  await node.getByRole('button').click()
  const window = page.locator('[data-composer][data-state="open"]')
  await expect(window.getByRole('tab', { name: '讨论', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(window.locator('.comment-body')).toHaveText(['最初的批注', '后来的批注'])
  await expect(window.getByLabel('问题与预期行为')).toHaveCount(0)
  await window.getByRole('button', { name: '添加新批注', exact: true }).click()
  await window.getByLabel('问题与预期行为').fill('追加在末尾的批注')
  await window.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect(window.locator('.comment-body')).toHaveText(['最初的批注', '后来的批注', '追加在末尾的批注'])
  await expect(window.locator('.comment-body').last()).toBeInViewport()
  await window.locator('.comment-card').first().getByRole('button', { name: '回复讨论', exact: true }).click()
  await window.getByLabel('补充说明').fill('回复最初意见')
  await window.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(window.locator('.comment-card').first()).toContainText('回复最初意见')
  await expect(window.locator('.comment-card').last()).not.toContainText('回复最初意见')
})

for (const mode of ['light', 'dark']) test(`glass ${mode} reading window shields text from the underlying graph`, async ({ page }, info) => {
  await page.addInitScript(mode => {
    localStorage.setItem('logic-margin:theme', 'glass')
    localStorage.setItem('logic-margin:mode', mode)
  }, mode)
  await page.goto('/')
  await page.getByLabel('外观设置', { exact: true }).click()
  await page.getByLabel('界面主题', { exact: true }).selectOption('glass')
  await page.locator(`#appearance-mode button[value="${mode}"]`).click()
  await page.keyboard.press('Escape')
  await page.locator('.react-flow__node[data-id="upgrade-start"] .node-title').click()
  await page.locator('.react-flow__node[data-id="upgrade-start"] .node-comment-button').click()
  const window = page.locator('[data-composer][data-state="open"]')
  const opacity = () => window.evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3] / 255
  })
  for (const tab of ['讨论', '详情']) {
    await window.getByRole('tab', { name: tab, exact: true }).click()
    expect(await opacity()).toBeGreaterThanOrEqual(.9)
  }
  await page.screenshot({ path: info.outputPath(`glass-${mode}-popup.png`) })
  await window.getByRole('button', { name: '移到侧栏编辑' }).click()
  expect(await opacity()).toBeGreaterThanOrEqual(.9)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await opacity()).toBeGreaterThanOrEqual(.9)
  await page.screenshot({ path: info.outputPath(`glass-${mode}-phone.png`) })
})
