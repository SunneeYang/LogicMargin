import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { contextReview } from './fixtures/context-review.ts'
import { largeCodeReview } from './fixtures/large-code-review.ts'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

for (const sample of [
  { name: 'short unified', lines: 194, split: false, mobile: false },
  { name: 'virtual unified', lines: 1998, split: false, mobile: false },
  { name: 'side by side', lines: 194, split: true, mobile: false },
  { name: 'phone', lines: 194, split: true, mobile: true },
]) test(`${sample.name} overview locates changes and follows scrolling, folding and language`, async ({ page, request }) => {
  if (sample.mobile) await page.setViewportSize({ width: 390, height: 844 })
  const review = contextReview(sample.lines)
  for (const document of [review.baseline!, review]) {
    const evidence = document.nodes[0].evidence![0]
    evidence.code = evidence.code!.replace('const item40 = 40;', `const item40 = "${'long-source-context-'.repeat(40)}";`)
    evidence.digest = hash(evidence.code)
    document.snapshot.files![0].sha256 = hash(`${'// preceding context\n'.repeat(100)}${evidence.code}`)
    document.snapshot.fingerprint = hash(JSON.stringify(document.snapshot.files))
  }
  const response = await request.post('/api/review-sessions', { data: { review } })
  expect(response.ok(), await response.text()).toBeTruthy()
  await page.goto(`/?session=${(await response.json()).id}`)
  // Include wide classic scrollbars even on systems that normally use overlay scrollbars.
  const nativeWidth = sample.name === 'virtual unified' ? 28 : 16
  await page.addStyleTag({ content: `.code-editor .cm-scroller, .code-editor .cm-mergeView { scrollbar-color: auto !important; scrollbar-width: auto !important; }
    .code-editor ::-webkit-scrollbar { width: ${nativeWidth}px; height: 14px; }
    .code-editor ::-webkit-scrollbar-thumb { background: rgb(255, 0, 255); }` })
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '统一', exact: true }).click()
  if (!sample.mobile) {
    await panel.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
    await page.locator('.resize-right').focus()
    await page.keyboard.press('End')
  }
  await panel.getByRole('button', { name: sample.split ? '并排' : '统一', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveCount(sample.split ? 2 : 1)
  const overview = panel.locator('.code-overview')
  const input = overview.getByRole('slider', { name: '当前片段差异总览', exact: true })
  await expect(input).toBeEnabled()
  await input.evaluate(element => { (element as HTMLElement).dataset.identity = 'overview' })
  await expect.poll(() => overview.locator('.is-added').count()).toBeGreaterThan(0)
  await expect.poll(() => overview.locator('.is-removed').count()).toBeGreaterThan(0)
  const scroll = panel.locator(sample.split ? '.cm-mergeView' : '.cm-scroller').first()
  const viewport = overview.locator('.code-overview-viewport')
  const column = await overview.evaluate(element => {
    const removed = element.querySelector('.is-removed')!.getBoundingClientRect()
    const added = element.querySelector('.is-added')!.getBoundingClientRect()
    const thumb = element.querySelector('.code-overview-viewport')!.getBoundingClientRect()
    return { removed: removed.toJSON(), added: added.toJSON(), thumb: thumb.toJSON() }
  })
  expect(column.removed.x).toBe(column.added.x)
  expect(column.removed.width).toBe(column.added.width)
  expect(column.removed.width).toBeGreaterThan(column.thumb.width)
  expect(column.removed.bottom).toBeLessThanOrEqual(column.added.y + 1)
  await expect.poll(async () => {
    const a = await overview.boundingBox(), b = await scroll.boundingBox()
    return !!a && !!b && a.x <= b.x + b.width - nativeWidth && a.x + a.width >= b.x + b.width - 1
  }).toBe(true)
  const gutter = await scroll.evaluate(element => element.getBoundingClientRect().right - (element as HTMLElement).offsetWidth + element.clientWidth)
  await expect.poll(() => overview.evaluate((element, x) => {
    const y = element.getBoundingClientRect().top + 40
    return element.contains(document.elementFromPoint(x + 8, y))
  }, gutter)).toBe(true)
  await expect.poll(() => scroll.evaluate(element => (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(nativeWidth)
  await panel.locator('.cm-editor').first().locator('[data-fold-id="1"] [data-context-edge="start"]').click()
  await input.press('End')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  await input.press('Home')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
  await expect.poll(() => viewport.evaluate(element => parseFloat((element as HTMLElement).style.top))).toBe(0)
  const start = parseFloat((await viewport.getAttribute('style'))!.match(/top:\s*([\d.]+)/)![1])
  const mark = (await overview.locator('.is-added').last().boundingBox())!
  const bounds = (await input.boundingBox())!
  await input.click({ position: { x: bounds.width / 2, y: mark.y + mark.height / 2 - bounds.y } })
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect(panel.locator('.cm-line').filter({ hasText: /^changed_later\(\);$/ }).last()).toBeInViewport()
  await expect.poll(async () => parseFloat((await viewport.getAttribute('style'))!.match(/top:\s*([\d.]+)/)![1])).toBeGreaterThan(start)
  await input.press('Home')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
  await input.press('End')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  const bottom = await scroll.evaluate(element => element.scrollTop)
  await input.press('PageUp')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
  const beforeArrow = await scroll.evaluate(element => element.scrollTop)
  await input.press('ArrowDown')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeArrow)
  const graph = page.locator('.react-flow__viewport')
  const transform = await graph.getAttribute('style')
  await input.press('End')
  const beforeWheel = await scroll.evaluate(element => element.scrollTop)
  await input.hover()
  await page.mouse.wheel(0, -120)
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(beforeWheel)
  expect(await graph.getAttribute('style')).toBe(transform)
  await input.press('Home')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
  await expect.poll(() => viewport.evaluate(element => parseFloat((element as HTMLElement).style.top))).toBe(0)
  const thumb = (await viewport.boundingBox())!
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.8, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Number(await input.inputValue())).toBeGreaterThan(500)
  if (sample.mobile) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    await input.press('Home')
    const point = (fraction: number) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * fraction, id: 0 })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0.2)] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(0.8)] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(async () => Number(await input.inputValue())).toBeGreaterThan(500)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0.5)] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await input.press('Home')
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
    await cdp.detach()
  }
  const oldHeight = await viewport.evaluate(element => element.getBoundingClientRect().height)
  await panel.getByRole('button', { name: '展开全文', exact: true }).click()
  await expect.poll(() => viewport.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(oldHeight)
  const expandedMarks = await overview.evaluate(element => ['.is-removed', '.is-added'].map(selector => element.querySelector(selector)!.getBoundingClientRect().toJSON()))
  expect(expandedMarks[0].bottom).toBeLessThanOrEqual(expandedMarks[1].y + 1)
  if (sample.lines > 200) expect(await panel.locator('.cm-line').count()).toBeLessThan(200)
  const menu = page.locator('.settings-dialog')
  await page.locator('.settings-trigger').click()
  await menu.locator('#interface-language button[value="en"]').click()
  await page.keyboard.press('Escape')
  await expect(overview.getByRole('slider', { name: 'Snippet change overview', exact: true })).toHaveAttribute('data-identity', 'overview')
  await expect(overview.getByRole('slider')).toHaveAttribute('aria-valuetext', /^Scroll position \d+%$/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (sample.split) {
    const horizontal = panel.locator('.cm-editor').first().locator('.cm-scroller')
    await horizontal.evaluate(element => { element.scrollLeft = element.scrollWidth })
    expect(await horizontal.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  }
  if (sample.mobile) expect(bounds.width).toBeGreaterThanOrEqual(44)
})

const nativeSource = Array.from({ length: 194 }, (_, index) => `const item${index} = ${index};`).join('\n')
for (const sample of [
  { name: 'EOF deletion', before: nativeSource, after: nativeSource.split('\n').slice(0, 150).join('\n'), removed: 1, added: 0 },
  { name: 'all deleted', before: nativeSource, after: '', removed: 1, added: 0 },
  { name: 'empty original', before: '', after: nativeSource, removed: 0, added: 1 },
  { name: 'identical', before: nativeSource, after: nativeSource, removed: 0, added: 0 },
]) test(`native overview handles ${sample.name} without phantom changes`, async ({ page, request }) => {
  const review = contextReview(194)
  for (const [document, code] of [[review.baseline!, sample.before], [review, sample.after]] as const) {
    Object.assign(document.nodes[0].evidence![0], { code, digest: hash(code), endLine: 100 + code.split('\n').length })
    document.snapshot.files![0].sha256 = hash(`${'// preceding context\n'.repeat(100)}${code}`)
    document.snapshot.fingerprint = hash(JSON.stringify(document.snapshot.files))
  }
  const response = await request.post('/api/review-sessions', { data: { review } })
  expect(response.ok(), await response.text()).toBeTruthy()
  await page.goto(`/?session=${(await response.json()).id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '统一', exact: true }).click()
  const overview = panel.locator('.code-overview')
  for (const [kind, count] of [['removed', sample.removed], ['added', sample.added]] as const) {
    if (!count) await expect(overview.locator(`.is-${kind}`)).toHaveCount(0)
    else await expect.poll(() => overview.locator(`.is-${kind}`).count()).toBeGreaterThan(0)
  }
  if (!sample.added && !sample.removed) await expect(overview).toBeHidden()
  else {
    await expect(overview).toBeVisible()
    await expect.poll(() => overview.evaluate(element => {
      const bounds = [...element.querySelectorAll('.code-overview-mark')].map(marker => marker.getBoundingClientRect())
      const height = element.getBoundingClientRect().height
      return bounds.length && height ? (Math.max(...bounds.map(box => box.bottom)) - Math.min(...bounds.map(box => box.top))) / height : 0
    })).toBeGreaterThan(0.65)
  }
})

test('large deletion has one removed band and stays virtualized', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: largeCodeReview() } })
  await page.goto(`/?session=${(await response.json()).id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="deleted"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '统一', exact: true }).click()
  const overview = panel.locator('.code-overview')
  await expect(overview.locator('.is-removed')).toHaveCount(1)
  await expect(overview.locator('.is-added')).toHaveCount(0)
  await panel.getByRole('button', { name: '展开全文', exact: true }).click()
  const input = overview.getByRole('slider')
  await input.press('End')
  expect(await panel.locator('.cm-line').count()).toBeLessThan(200)
  await input.press('Home')
  await expect.poll(() => panel.locator('.cm-scroller').evaluate(element => element.scrollTop)).toBe(0)
})
