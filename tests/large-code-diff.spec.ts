import { test, expect } from '@playwright/test'
import { largeCodeReview } from './fixtures/large-code-review.ts'

test('a large deleted block renders only visible lines and expands without replacing the editor', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: largeCodeReview() } })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="deleted"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '统一', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveCount(1)
  await expect(panel.locator('.cm-deletedLine').first()).toBeVisible()
  expect(await panel.locator('.cm-deletedLine').count()).toBeLessThan(150)
  await panel.locator('.cm-editor').evaluate(element => { element.dataset.identity = 'retained' })
  await panel.getByRole('button', { name: '展开全文', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveAttribute('data-identity', 'retained')
  await panel.getByRole('button', { name: '折叠未变', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveAttribute('data-identity', 'retained')
})

test('offscreen files defer layout work and every expanded file becomes readable when reached', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: largeCodeReview() } })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
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
  await expect(panel.locator('.code-evidence-body')).toHaveCount(12)
  expect(await panel.locator('.cm-editor').count()).toBeLessThan(12)
  await panel.getByRole('button', { name: '并排', exact: true }).click()
  for (let index = 0; index < 12; index++) {
    const section = panel.locator('.code-evidence-section').nth(index)
    await section.locator('summary').scrollIntoViewIfNeeded()
    await section.locator('.code-evidence-body').scrollIntoViewIfNeeded()
    await expect(section.locator('.code-evidence-body')).toHaveAttribute('data-code-layout', 'split')
    await expect(section.locator('.cm-merge-b .cm-content')).toContainText('item10 = 10010')
  }
  expect(errors).toEqual([])
})

for (const target of ['sparse', 'replaced', 'deleted', 'multiple']) {
  test(`large code diff remains complete, scrollable and lazy (${target})`, async ({ page, request }) => {
    const review = largeCodeReview()
    const response = await request.post('/api/review-sessions', { data: { review } })
    expect(response.ok()).toBeTruthy()
    const session = await response.json()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/?session=${session.id}`)
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await page.locator(`.react-flow__node[data-id="${target}"] .node-comment-button`).click()
    const panel = page.locator('[data-composer][data-state="open"]')
    await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
    await panel.getByRole('button', { name: '统一', exact: true }).click()
    await expect(panel.locator('.cm-editor')).toHaveCount(1)
    await expect(panel.locator('.code-evidence-section')).toHaveCount(target === 'multiple' ? 12 : 1)
    if (target === 'deleted' || target === 'replaced') {
      await expect(panel.locator('.cm-deletedLine').first()).toHaveText('const item0 = 0;')
    }
    await panel.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
    await page.getByRole('separator', { name: '调整右侧栏宽度' }).focus()
    await page.keyboard.press('End')
    await panel.getByRole('button', { name: '展开全文', exact: true }).click()
    if (target === 'sparse') {
      const scroll = panel.locator('.cm-scroller')
      await panel.getByRole('button', { name: '下一处差异', exact: true }).click()
      await panel.getByRole('button', { name: '下一处差异', exact: true }).click()
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(800)
      await page.keyboard.press('Shift+F7')
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(500)
    }
    for (const split of [false, true]) {
      await panel.getByRole('button', { name: split ? '并排' : '统一', exact: true }).click()
      const scroll = panel.locator(split ? '.cm-mergeView' : '.cm-scroller').first()
      await scroll.evaluate(element => { element.scrollTop = 0 })
      await scroll.hover()
      await page.mouse.wheel(0, 700)
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(200)
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
      const content = panel.locator(split ? '.cm-merge-b .cm-content' : '.cm-content').first()
      await expect(content).toContainText(target === 'replaced' ? 'rule1999' : 'item1999')
      if (split) await expect(panel.locator('.cm-merge-a .cm-content')).toContainText('item1999')
      await expect(content).toHaveAttribute('contenteditable', 'false')
      await expect(content).toHaveAttribute('aria-readonly', 'true')
    }
    if (target === 'multiple') {
      const second = panel.locator('.code-evidence-section').nth(1)
      await second.locator('summary').click()
      await second.locator('.code-evidence-body').scrollIntoViewIfNeeded()
      await expect(panel.locator('.cm-editor')).toHaveCount(4)
      await second.locator('summary').click()
      await expect(panel.locator('.cm-editor')).toHaveCount(2)
    }
    const next = target === 'replaced' ? 'sparse' : 'replaced'
    await page.locator(`.react-flow__node[data-id="${next}"] .node-title`).evaluate(element => (element as HTMLElement).click())
    await expect(panel.locator('.discussion-target')).toHaveText(review.nodes.find(node => node.id === next)!.title)
    await expect(panel.locator('.code-evidence-section')).toHaveCount(1)
    await expect(panel.locator('.cm-editor')).toHaveCount(2)
    await expect(panel.locator('.cm-merge-b .cm-content')).toContainText(next === 'replaced' ? 'rule0' : 'item10 = 10010')
    expect(errors).toEqual([])
  })
}
