import { expect, test } from '@playwright/test'
import { contextReview } from './fixtures/context-review.ts'


for (const sample of [
  { name: 'short unified', lines: 120, split: false, mobile: false },
  { name: 'virtual unified', lines: 1998, split: false, mobile: false },
  { name: 'side by side', lines: 120, split: true, mobile: false },
  { name: 'phone unified', lines: 120, split: false, mobile: true },
  { name: 'phone side by side', lines: 120, split: true, mobile: true },
]) test(`${sample.name} expands context incrementally without losing source positions or language state`, async ({ page, request }) => {
  if (sample.mobile) await page.setViewportSize({ width: 390, height: 844 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const response = await request.post('/api/review-sessions', { data: { review: contextReview(sample.lines) } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').evaluate(element => (element as HTMLElement).click())
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  if (!sample.mobile) {
    await panel.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
    await page.locator('.resize-right').focus()
    await page.keyboard.press('End')
  }
  if (sample.split) await panel.getByRole('button', { name: '并排', exact: true }).click()
  const editors = panel.locator('.cm-editor')
  await expect(editors).toHaveCount(sample.split ? 2 : 1)
  await editors.evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).dataset.identity = 'context' }))
  const first = editors.first(), middle = first.locator('[data-fold-id="1"]')
  await expect(middle).toBeVisible()
  const initial = Number(await middle.getAttribute('data-line-count'))
  expect(initial).toBeGreaterThan(40)
  await expect(first.locator('.cm-line').filter({ hasText: /^const item34 = 34;$/ })).toHaveCount(0)
  await middle.getByRole('button', { name: '向下展开 20 行', exact: true }).click()
  await expect(middle).toHaveAttribute('data-line-count', String(initial - 20))
  await expect(first.locator('.cm-line').filter({ hasText: /^const item34 = 34;$/ })).toHaveCount(1)
  await expect(first.locator(`${sample.split ? '.cm-lineNumbers' : '.cm-originalLineNumbers'} .cm-gutterElement`).filter({ hasText: /^135$/ })).toHaveCount(1)
  await expect(editors.last().locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^137$/ })).toHaveCount(1)
  await middle.getByRole('button', { name: '向上展开 20 行', exact: true }).click()
  await expect(middle).toHaveAttribute('data-line-count', String(initial - 40))
  if (sample.split) {
    await expect(editors.last().locator('[data-fold-id="1"]')).toHaveAttribute('data-line-count', String(initial - 40))
    const lineA = first.locator('.cm-line').filter({ hasText: /^const item87 = 87;$/ })
    const lineB = editors.last().locator('.cm-line').filter({ hasText: /^const item87 = 87;$/ })
    await lineA.scrollIntoViewIfNeeded()
    await expect.poll(async () => Math.abs((await lineA.boundingBox())!.y - (await lineB.boundingBox())!.y)).toBeLessThan(2)
  }
  const menu = page.locator('.appearance-menu')
  await menu.locator('summary').click()
  await menu.locator('#interface-language button[value="en"]').click()
  await menu.locator('summary').click()
  await expect(middle).toHaveAttribute('data-line-count', String(initial - 40))
  await expect(middle.getByRole('button', { name: /Expand \d+ lines above/ })).toBeVisible()
  if (sample.mobile) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const editor of await editors.all()) {
      await editor.locator('.cm-scroller').evaluate(element => { element.scrollLeft = element.scrollWidth })
      const bounds = (await editor.boundingBox())!
      const fold = editor.locator('[data-fold-id="1"]')
      for (const box of await fold.getByRole('button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()))) {
        expect(box.width).toBeGreaterThan(0)
        expect(box.height).toBeGreaterThanOrEqual(44)
        expect(box.x).toBeGreaterThanOrEqual(bounds.x)
        expect(box.right).toBeLessThanOrEqual(bounds.x + bounds.width)
      }
    }
  }
  if (sample.name === 'short unified' || sample.mobile) {
    await middle.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `.scratch/i18n-docs/context-${sample.name.replaceAll(' ', '-')}.png` })
  }
  await middle.locator('[data-context-edge="all"]').click()
  await expect(first.locator('[data-fold-id="1"]')).toHaveCount(0)
  if (sample.split) await expect(editors.last().locator('[data-fold-id="1"]')).toHaveCount(0)
  const scroll = panel.locator(sample.split ? '.cm-mergeView' : '.cm-scroller').first()
  await scroll.hover()
  await page.mouse.wheel(0, -200000)
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
  const top = first.locator('[data-fold-id="0"]')
  await expect(top.locator('[data-context-edge="start"]')).toHaveCount(0)
  const topCount = Number(await top.getAttribute('data-line-count'))
  await top.getByRole('button', { name: /Expand \d+ lines above/ }).focus()
  await expect(top.locator('[data-context-edge="end"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(top).toHaveAttribute('data-line-count', String(topCount - 20))
  await expect(top.locator('[data-context-edge="end"]')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(top).toHaveCount(0)
  await scroll.hover()
  await page.mouse.wheel(0, 200000)
  const bottom = first.locator('[data-fold-id="2"]')
  await expect(bottom).toBeVisible()
  await expect(bottom.locator('[data-context-edge="end"]')).toHaveCount(0)
  await bottom.locator('[data-context-edge="start"]').click()
  await panel.getByRole('button', { name: 'Expand all', exact: true }).click()
  await expect(panel.locator('.code-context-fold')).toHaveCount(0)
  if (sample.lines > 200) expect(await first.locator('.cm-line').count()).toBeLessThan(200)
  await panel.getByRole('button', { name: 'Collapse unchanged', exact: true }).click()
  await expect(first.locator('[data-fold-id="1"]')).toHaveAttribute('data-line-count', String(initial))
  for (const editor of await editors.all()) await expect(editor).toHaveAttribute('data-identity', 'context')
  expect(errors).toEqual([])
})

for (const sample of [
  { name: 'short unified', lines: 194, split: false },
  { name: 'side by side', lines: 194, split: true },
  { name: 'virtual unified', lines: 1998, split: false },
]) test(`${sample.name} keeps expansion buttons at both boundaries across repeated clicks`, async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: contextReview(sample.lines) } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').evaluate(element => (element as HTMLElement).click())
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
  await page.locator('.resize-right').focus()
  await page.keyboard.press('End')
  if (sample.split) await panel.getByRole('button', { name: '并排', exact: true }).click()
  const editors = panel.locator('.cm-editor'), first = editors.first()
  await expect(editors).toHaveCount(sample.split ? 2 : 1)
  const gap = first.locator('[data-fold-id="1"]')
  await expect(gap).toBeVisible()
  const count = Number(await gap.getAttribute('data-line-count'))
  expect(count).toBeGreaterThan(120)
  const boxes = await gap.evaluate(element => [element,
    element.querySelector('[data-context-edge="start"]')!, element.querySelector('[data-context-edge="all"]')!,
    element.querySelector('[data-context-edge="end"]')!].map(item => item.getBoundingClientRect().toJSON()))
  expect(Math.abs(boxes[1]!.y - boxes[0]!.y)).toBeLessThan(1)
  expect(boxes[1]!.y + boxes[1]!.height).toBeLessThanOrEqual(boxes[2]!.y)
  expect(boxes[2]!.y + boxes[2]!.height).toBeLessThanOrEqual(boxes[3]!.y)
  expect(Math.abs(boxes[3]!.y + boxes[3]!.height - boxes[0]!.y - boxes[0]!.height)).toBeLessThan(1)
  let remaining = count
  for (const edge of ['start', 'end'] as const) for (let click = 0; click < 3; click++) {
    await gap.locator(`[data-context-edge="${edge}"]`).click()
    remaining -= 20
    for (const editor of await editors.all()) await expect(editor.locator('[data-fold-id="1"]')).toHaveAttribute('data-line-count', String(remaining))
    await expect(gap.locator(`[data-context-edge="${edge}"]`)).toBeVisible()
  }
  await gap.locator(`[data-context-edge="${remaining <= 20 ? 'end' : 'all'}"]`).click()
  for (const editor of await editors.all()) await expect(editor.locator('[data-fold-id="1"]')).toHaveCount(0)
  const scroll = panel.locator(sample.split ? '.cm-mergeView' : '.cm-scroller').first()
  await scroll.evaluate(element => { element.scrollTop = 0 })
  const head = first.locator('[data-fold-id="0"]')
  await expect(head.locator('[data-context-edge="start"]')).toHaveCount(0)
  await head.locator('[data-context-edge="end"]').click()
  await expect(head).toHaveAttribute('data-line-count', '7')
  await head.locator('[data-context-edge="end"]').click()
  await expect(head).toHaveCount(0)
  await scroll.hover()
  await page.mouse.wheel(0, 200000)
  const tail = first.locator('[data-fold-id="2"]')
  await expect(tail).toBeVisible()
  await expect(tail.locator('[data-context-edge="end"]')).toHaveCount(0)
  const tailCount = Number(await tail.getAttribute('data-line-count'))
  await tail.locator('[data-context-edge="start"]').click()
  await expect(tail).toHaveAttribute('data-line-count', String(tailCount - 20))
  await tail.locator('[data-context-edge="start"]').click()
  await expect(panel.locator('.code-context-fold')).toHaveCount(0)
})
