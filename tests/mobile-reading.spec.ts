import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page, TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession } from '../src/session-types.ts'

async function readingMetrics(page: Page, info: TestInfo, name: string) {
  const metrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing measurement target: ${selector}`)
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    const viewport = document.querySelector('.react-flow__viewport')!
    const transform = getComputedStyle(viewport).transform
    const matrix = new DOMMatrixReadOnly(transform)
    const title = document.querySelector('.react-flow__node[data-id="upgrade-start"] .node-title')!
    return {
      device: {
        width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio,
        touchPoints: navigator.maxTouchPoints, coarsePointer: matchMedia('(pointer: coarse)').matches,
      },
      transform, zoom: matrix.a,
      renderedTitleSize: parseFloat(getComputedStyle(title).fontSize) * matrix.a,
      node: rect('.react-flow__node[data-id="upgrade-start"]'),
      comment: rect('.react-flow__node[data-id="upgrade-start"] .node-comment-button'),
      toolbar: rect('.graph-toolbar'), canvas: rect('.canvas'), controls: rect('.react-flow__controls'),
    }
  })
  const screenshot = info.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshot })
  await info.attach(`${name}-screenshot`, { path: screenshot, contentType: 'image/png' })
  await info.attach(`${name}-metrics`, { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
  return metrics
}

async function expectToolContentsInsideControls(page: Page, info: TestInfo, name: string) {
  const measurements = await page.locator('.canvas-tool-content').evaluate(popup => {
    const rect = (box: DOMRect) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height })
    return [...popup.querySelectorAll<HTMLElement>('button, summary')].flatMap(control => {
      const bounds = rect(control.getBoundingClientRect())
      if (!bounds.width || !bounds.height || getComputedStyle(control).visibility === 'hidden') return []
      const fragments = [...control.querySelectorAll('svg')].flatMap(svg => {
        const box = rect(svg.getBoundingClientRect())
        return box.width && box.height ? [{ kind: 'svg', text: '', bounds: box }] : []
      })
      const texts = document.createTreeWalker(control, NodeFilter.SHOW_TEXT)
      for (let text = texts.nextNode(); text; text = texts.nextNode()) {
        if (!text.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(text)
        for (const box of range.getClientRects()) {
          if (box.width && box.height) fragments.push({ kind: 'text', text: text.textContent.trim(), bounds: rect(box) })
        }
      }
      return [{ label: control.getAttribute('aria-label') ?? control.textContent?.trim(), bounds, fragments }]
    })
  })
  const screenshot = info.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshot })
  await info.attach(`${name}-screenshot`, { path: screenshot, contentType: 'image/png' })
  await info.attach(`${name}-control-bounds`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  const overflowing = measurements.flatMap(control => control.fragments.flatMap(fragment => {
    const box = fragment.bounds
    const border = control.bounds
    return box.left < border.left - 0.5 || box.right > border.right + 0.5 || box.top < border.top - 0.5 || box.bottom > border.bottom + 0.5
      ? [{ control: control.label, border, ...fragment }] : []
  }))
  expect.soft(overflowing, `${name}: tool text and icons must fit their own button border`).toEqual([])
}

async function mobileTwoRoundSession(request: APIRequestContext) {
  const review = structuredClone(sampleReview)
  review.id = 'mobile-reading-two-rounds'
  review.title = '手机端跨轮评审'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.filter(node => node.sceneId === review.scenes[0].id).slice(0, 3)
    .map(node => ({ ...node, evidence: [] }))
  const ids = new Set(review.nodes.map(node => node.id))
  review.edges = review.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  review.comments = []
  const createdResponse = await request.post('/api/review-sessions', { data: { review } })
  expect(createdResponse.ok()).toBeTruthy()
  const created: ReviewSession = await createdResponse.json()
  const path = `/api/review-sessions/${created.id}`
  const comment = addComment(review, [{ kind: 'node', id: 'upgrade-start' }], '第一轮：核对失败时的资源状态。').comments[0]
  const savedResponse = await request.post(`${path}/mutations`, { data: {
    round: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }],
  } })
  expect(savedResponse.ok()).toBeTruthy()
  const saved: ReviewSession = await savedResponse.json()
  const finishedResponse = await request.post(`${path}/finish`, { data: { expectedVersion: saved.version, kind: 'feedback' } })
  expect(finishedResponse.ok()).toBeTruthy()
  const finished: ReviewSession = await finishedResponse.json()
  const next = structuredClone(finished.review)
  next.nodes[0].summary = '第二轮：失败时保持资源不变。'
  const files = [{ path: 'mobile-reading-fixture.ts', sha256: createHash('sha256').update('mobile reading fixture\n').digest('hex') }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  next.snapshot = { ...next.snapshot, files, fingerprint }
  const publishedResponse = await request.post(`${path}/revise`, { data: {
    expectedVersion: finished.version, review: next,
    publication: { baseRound: 1, summary: '手机端跨轮视图测试：补充资源说明。',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } },
    replies: [{ commentId: comment.id, body: '第二轮已同步资源规则。' }],
  } })
  expect(publishedResponse.ok()).toBeTruthy()
  const published: ReviewSession = await publishedResponse.json()
  return published
}

for (const device of [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  { name: 'short-wide-phone', viewport: { width: 684, height: 584 }, deviceScaleFactor: 2.2 },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, deviceScaleFactor: device.deviceScaleFactor, isMobile: true, hasTouch: true })

    test('starts with readable nodes and one compact toolbar row', async ({ page }, info) => {
      await page.goto('/')
      await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
      const metrics = await readingMetrics(page, info, 'initial-mobile-reading')

      expect.soft(metrics.renderedTitleSize, 'actual title size after canvas scaling').toBeGreaterThanOrEqual(12)
      expect.soft(metrics.node.width, 'a node should keep approximately its 248px reading width').toBeGreaterThanOrEqual(232)
      expect.soft(metrics.comment.width, 'scaled comment button touch width').toBeGreaterThanOrEqual(40)
      expect.soft(metrics.comment.height, 'scaled comment button touch height').toBeGreaterThanOrEqual(40)
      expect.soft(metrics.toolbar.height, 'mobile toolbar must stay in one row').toBeLessThanOrEqual(56)
      expect.soft(metrics.controls.height, 'zoom controls must use a horizontal row').toBeLessThanOrEqual(52)
      expect.soft(metrics.node.y).toBeGreaterThanOrEqual(metrics.canvas.y)
      expect.soft(metrics.node.y + metrics.node.height).toBeLessThanOrEqual(metrics.canvas.y + metrics.canvas.height)
    })

    test('touch comments recover drafts and reopen with replies in a separate dark dialog', async ({ page }, info) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.goto('/')
      await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
      await readingMetrics(page, info, 'before-touch-comment')

      const emptyBadge = page.getByRole('button', { name: '讨论：发起总等级升级', exact: true })
      await emptyBadge.tap()
      await page.locator('[data-composer]').getByRole('button', { name: '添加新批注', exact: true }).tap()
      const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
      await expect(editor).toBeInViewport({ ratio: 1 })
      await expect(editor.getByLabel('问题与预期行为')).not.toBeFocused()
      const opinion = `手机批注 ${device.name}：失败时应该保留资源。`
      await editor.getByLabel('问题与预期行为').fill(opinion)
      await editor.getByRole('button', { name: '关闭讨论', exact: true }).tap()
      await expect(editor).not.toBeVisible()
      await page.reload()
      await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
      await emptyBadge.tap()
      await page.locator('[data-composer]').getByRole('button', { name: '添加新批注', exact: true }).tap()
      await expect(editor.getByLabel('问题与预期行为')).toHaveValue(opinion)
      await expect(editor.getByRole('button', { name: '添加批注', exact: true })).toBeInViewport({ ratio: 1 })
      await editor.getByRole('button', { name: '添加批注', exact: true }).tap()
      await expect(editor.getByLabel('问题与预期行为')).toHaveCount(0)
      await editor.getByRole('button', { name: '关闭讨论', exact: true }).tap()

      const savedBadge = page.getByRole('button', { name: '讨论：发起总等级升级（1 条）', exact: true })
      await savedBadge.tap()
      const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
      await expect(discussion).toBeInViewport({ ratio: 1 })
      await expect(discussion.locator('.comment-body')).toHaveText(opinion)
      await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
      await expect(discussion).toHaveClass(/is-inline/)
      await expect(discussion).toHaveCSS('position', 'fixed')
      await discussion.getByRole('button', { name: '回复讨论', exact: true }).tap()
      const reply = '手机复核补充：请核对失败出口。'
      await discussion.getByLabel('补充说明', { exact: true }).fill(reply)
      const save = discussion.getByRole('button', { name: '保存回复', exact: true })
      await save.scrollIntoViewIfNeeded()
      await expect(save).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: info.outputPath('mobile-touch-reply.png') })
      await save.tap()
      await expect(discussion).toContainText(reply)
      await discussion.getByRole('button', { name: '关闭讨论', exact: true }).tap()
      await page.reload()
      await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
      await savedBadge.tap()
      await expect(discussion).toContainText(opinion)
      await expect(discussion).toContainText(reply)
      await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(device.viewport.width)
      expect(errors).toEqual([])
    })
  })
}

test.describe('mobile reading actions', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

  test('both scope comment actions are directly reachable in mobile tools', async ({ page }) => {
    for (const scope of ['scene', 'review'] as const) {
      await page.goto('/')
      await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
      await page.locator('.canvas-tools > summary').tap()
      await expect(page.locator('.scope-actions')).toHaveCount(0)
      const scopes = page.getByRole('group', { name: '批注范围', exact: true })
      await expect(scopes.getByRole('button')).toHaveCount(2)
      await scopes.getByRole('button', { name: scope === 'scene' ? '批注此场景' : '批注整个评审', exact: true }).tap()
      const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
      await editor.getByLabel('问题与预期行为').fill(`手机范围批注：${scope}`)
      await editor.getByRole('button', { name: '添加批注', exact: true }).tap()
      const saved = await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!), sampleReview.id)
      expect(saved.comments.at(-1).targets).toEqual([{ kind: scope, id: scope === 'scene' ? sampleReview.scenes[0].id : sampleReview.id }])
    }
  })

  test('returns from overview to reading and keeps display settings reachable', async ({ page }, info) => {
    await page.goto('/')
    await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
    await readingMetrics(page, info, 'before-overview')
    await page.getByRole('button', { name: '显示完整流程', exact: true }).tap()
    await expect.poll(() => page.locator('.react-flow__viewport').evaluate(element =>
      new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
    )).toBeLessThan(0.9)
    const overview = await readingMetrics(page, info, 'mobile-overview')
    const restore = page.getByRole('button', { name: '恢复阅读视图', exact: true })
    await expect(restore).toBeInViewport({ ratio: 1 })
    await restore.tap()
    await expect.poll(async () => {
      return page.locator('.react-flow__node[data-id="upgrade-start"] .node-title').evaluate(element => {
        const viewport = document.querySelector('.react-flow__viewport')!
        return parseFloat(getComputedStyle(element).fontSize) * new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
      })
    }).toBeGreaterThanOrEqual(12)
    const reading = await readingMetrics(page, info, 'restored-mobile-reading')
    expect(reading.zoom).toBeGreaterThan(overview.zoom)
    await expect(page.locator('.react-flow__node[data-id="upgrade-start"]')).toBeInViewport({ ratio: 1 })

    const settings = page.getByText('显示设置', { exact: true })
    await expect(settings).toBeInViewport({ ratio: 1 })
    await settings.tap()
    const appearance = page.getByRole('group', { name: '节点显示方式', exact: true })
    await expect(appearance).toBeInViewport({ ratio: 1 })
    await appearance.getByRole('button', { name: '多样式', exact: true }).tap()
    await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'distinct')

    await settings.tap()
    await page.locator('summary[aria-label="画布工具"]').tap()
    const select = page.getByRole('button', { name: '框选', exact: true })
    await expect(select).toBeInViewport({ ratio: 1 })
    await select.tap()
    await page.locator('summary[aria-label="画布工具"]').tap()
    await expect(select).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '浏览', exact: true }).tap()
    await page.locator('summary[aria-label="画布工具"]').tap()
    await expect(page.getByRole('button', { name: '浏览', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('round two versions remain reachable in one toolbar row after rotating a touch viewport', async ({ page, request }, info) => {
    const session = await mobileTwoRoundSession(request)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(`/?session=${session.id}`)
    await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
    const initial = await readingMetrics(page, info, 'mobile-round-two')
    expect(initial.toolbar.height).toBeLessThanOrEqual(56)
    const canvas = page.locator('.canvas')
    const tools = page.locator('summary[aria-label="画布工具"]')
    await expect(tools).toBeInViewport({ ratio: 1 })
    await tools.tap()
    const before = page.getByRole('button', { name: '修改前 R1', exact: true })
    const current = page.getByRole('button', { name: '当前 R2', exact: true })
    await expect(before).toBeInViewport({ ratio: 1 })
    await expect(current).toHaveAttribute('aria-pressed', 'true')
    await before.tap()
    await expect(canvas).toHaveAttribute('data-readonly', 'true')
    await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
    if (await tools.evaluate(element => element.closest('details')?.open)) await tools.tap()
    await expect(page.locator('.react-flow__node[data-id="upgrade-start"]')).toBeInViewport({ ratio: 1 })

    await page.setViewportSize({ width: 684, height: 584 })
    const rotated = await readingMetrics(page, info, 'rotated-round-two')
    expect(rotated.toolbar.height).toBeLessThanOrEqual(56)
    expect(rotated.renderedTitleSize).toBeGreaterThanOrEqual(12)
    await tools.tap()
    await expect(current).toBeInViewport({ ratio: 1 })
    await expect(before).toHaveAttribute('aria-pressed', 'true')
    await current.tap()
    await expect(canvas).not.toHaveAttribute('data-readonly', 'true')
    await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
    if (await tools.evaluate(element => element.closest('details')?.open)) await tools.tap()
    await expect(page.locator('.react-flow__node[data-id="upgrade-start"]')).toContainText('第二轮：失败时保持资源不变。')
    await page.getByRole('button', { name: '讨论：发起总等级升级（1 条）', exact: true }).tap()
    const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
    await expect(discussion).toBeInViewport({ ratio: 1 })
    await expect(discussion).toContainText('第一轮：核对失败时的资源状态。')
    await expect(discussion).toContainText('第二轮已同步资源规则。')
    await expect(discussion.getByRole('button', { name: '复核并确认解决', exact: true })).toBeEnabled()
  })
})

for (const viewport of [
  { width: 320, height: 812 },
  { width: 390, height: 844 },
  { width: 684, height: 584 },
]) {
  test.describe(`focus-popup-${viewport.width}`, () => {
    test.use({ viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

    test('keeps all tool labels and icons inside their own controls through focus and panel changes', async ({ page }, info) => {
      const tools = page.locator('summary[aria-label="画布工具"]')
      const panel = page.getByRole('button', { name: /^评审面板/ })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.goto('/')
        await page.locator('.canvas[data-viewport-ready="true"]').waitFor({ state: 'visible' })
        await tools.tap()
        await expectToolContentsInsideControls(page, info, `${colorScheme}-panel-closed-unselected`)
        await tools.tap()

        await panel.tap()
        await tools.tap()
        await expectToolContentsInsideControls(page, info, `${colorScheme}-panel-open-unselected`)
        await tools.tap()
        await panel.tap()
        await page.locator('.react-flow__node[data-id="upgrade-start"] .node-title').tap()
        await tools.tap()
        await expectToolContentsInsideControls(page, info, `${colorScheme}-node-selected`)
        await expect(page.getByRole('button', { name: '定位当前选择', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '清除选择', exact: true })).toBeVisible()

        await page.getByRole('button', { name: '专注画布', exact: true }).tap()
        await expect(page.locator('.app-shell')).toHaveClass(/is-focused/)
        await tools.tap()
        await expectToolContentsInsideControls(page, info, `${colorScheme}-focus-entered`)
        await page.getByRole('button', { name: '退出专注', exact: true }).tap()
        await expect(page.locator('.app-shell')).not.toHaveClass(/is-focused/)
        await tools.tap()
        await expectToolContentsInsideControls(page, info, `${colorScheme}-focus-exited`)
        await page.getByRole('button', { name: '清除选择', exact: true }).tap()
        await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
      }
    })
  })
}
