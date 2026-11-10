import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession } from '../src/session-types.ts'

async function twoRoundSession(request: APIRequestContext) {
  const review = structuredClone(sampleReview)
  review.id = 'revision-layout-fixture'
  review.title = '跨轮布局与阅读位置'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.filter(node => node.sceneId === review.scenes[0].id).slice(0, 5)
    .map((node, index) => ({ ...node, position: { x: 0, y: index * 180 }, evidence: [] }))
  const ids = new Set(review.nodes.map(node => node.id))
  review.edges = review.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  review.comments = []
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok()).toBeTruthy()
  const session: ReviewSession = await created.json()
  const path = `/api/review-sessions/${session.id}`
  const comment = addComment(review, [{ kind: 'node', id: 'upgrade-toggle' }], '跨轮核对关闭功能时的拒绝出口。').comments[0]
  const saved = await request.post(`${path}/mutations`, { data: {
    round: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }],
  } })
  expect(saved.ok()).toBeTruthy()
  const state: ReviewSession = await saved.json()
  const next = structuredClone(state.review)
  next.nodes[1].summary = '新版规则：功能关闭时保留现有资源，不进入升级处理。'
  const files = [{ path: 'layout-fixture.ts', sha256: createHash('sha256').update('synthetic layout fixture\n').digest('hex') }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  next.snapshot = { ...next.snapshot, files, fingerprint }
  const published = await request.post(`${path}/revise`, { data: {
    expectedVersion: state.version, review: next,
    publication: { baseRound: 1, summary: '测试夹具：更新功能关闭时的拒绝规则。',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } },
    replies: [{ commentId: comment.id, body: '第二轮已同步规则，请核对当前图与原始意见。' }],
  } })
  expect(published.ok()).toBeTruthy()
  return { session: await published.json() as ReviewSession, commentId: comment.id }
}

async function viewport(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { zoom: matrix.a, x: matrix.e, y: matrix.f }
  })
}

async function canvasLayout(page: Page) {
  return page.locator('.canvas').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top, bottom: rect.bottom,
      visibleHeight: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)),
      pageHeight: document.documentElement.scrollHeight, pageWidth: document.documentElement.scrollWidth,
    }
  })
}

test('a saved branch return keeps only its two required corners after measurement and node lift', async ({ page, request }) => {
  const review = structuredClone(sampleReview)
  review.id = 'simple-return-corner'
  review.comments = []
  review.scenes = [review.scenes[0]]
  const template = review.nodes[0]
  review.nodes = ['station', 'branch', 'guard'].map((id, index) => ({ ...template, id, title: id, summary: '', evidence: [],
    sceneId: review.scenes[0].id, position: { x: id === 'branch' ? 0 : 512, y: index ? 600 : 0 },
  }))
  review.edges = [['a', 'guard', 'branch'], ['b', 'branch', 'station']].map(([id, source, target]) => ({
    id, source, target, sceneId: review.scenes[0].id, label: '继续', detail: '',
  }))
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok()).toBeTruthy()
  const session: ReviewSession = await created.json()
  await page.goto(`/?session=${session.id}`)
  const path = page.locator('.react-flow__edge[data-id="b"] .react-flow__edge-path')
  await expect(path).toBeVisible()
  const corners = async () => ((await path.getAttribute('d'))?.match(/Q/g) ?? []).length
  await expect.poll(corners).toBe(2)
  await page.locator('.react-flow__node[data-id="branch"]').hover()
  await expect.poll(corners).toBe(2)
  await page.locator('.react-flow__node[data-id="branch"]').click()
  await expect.poll(corners).toBe(2)
})

test('comparison preserves a compact authored main line when replaced steps occupy the same slot', async ({ page, request }) => {
  const review = structuredClone(sampleReview)
  review.id = 'rigid-comparison-topology'
  review.comments = []
  review.scenes = [review.scenes[0]]
  const makeNode = (id: string, x: number, y: number) => ({ ...review.nodes[0], id, title: id, summary: '', evidence: [],
    sceneId: review.scenes[0].id, position: { x, y } })
  const makeEdges = (start: string) => [['start', start, 'work'], ['finish', 'work', 'done'], ['skip', start, 'done']].map(([id, source, target]) => ({
    id, source, target, sceneId: review.scenes[0].id, label: id, detail: '',
  }))
  review.nodes = [makeNode('new', 600, 420), makeNode('work', 600, 630), makeNode('done', 600, 840)]
  review.edges = makeEdges('new')
  review.baseline = structuredClone(review)
  review.baseline.nodes = [makeNode('old', 0, 0), makeNode('work', 0, 210), makeNode('done', 0, 420)]
  review.baseline.edges = makeEdges('old')
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok()).toBeTruthy()
  const session: ReviewSession = await created.json()
  await page.goto(`/?session=${session.id}`)
  const nodes = page.locator('.react-flow__node')
  const positions = () => nodes.evaluateAll(elements => Object.fromEntries(elements.map(element => {
    const matrix = new DOMMatrixReadOnly((element as HTMLElement).style.transform)
    return [element.getAttribute('data-id')!, { x: matrix.m41, y: matrix.m42 }]
  })))
  await expect(nodes).toHaveCount(3)
  await expect.poll(async () => new Set(Object.values(await positions()).map(position => position.x)).size).toBe(1)
  for (const id of ['start', 'finish']) {
    await expect.poll(async () => (await page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).getAttribute('d'))?.includes('Q')).toBe(false)
  }
  const current = await positions()
  await page.getByRole('button', { name: '基线 B', exact: true }).click()
  await expect(page.locator('.react-flow__node[data-id="old"]')).toBeVisible()
  await expect.poll(async () => new Set(Object.values(await positions()).map(position => position.x)).size).toBe(1)
  for (const id of ['work', 'done']) await expect.poll(async () => (await positions())[id]).toEqual(current[id])
})

test('swapped comparison lanes keep the rendered edge lines horizontal or vertical', async ({ page, request }) => {
  const review = structuredClone(sampleReview)
  review.id = 'swapped-lanes-orthogonal'
  review.comments = []
  review.scenes = [review.scenes[0]]
  const makeNode = (id: string, x: number, y: number) => ({ ...review.nodes[0], id, title: id, summary: '', evidence: [],
    sceneId: review.scenes[0].id, position: { x, y } })
  review.nodes = [makeNode('a', 0, 0), makeNode('b', 0, 360), makeNode('c', 600, 360)]
  review.edges = ['b', 'c'].map(target => ({ id: `a-${target}`, source: 'a', target, sceneId: review.scenes[0].id, label: target, detail: '' }))
  review.baseline = structuredClone(review)
  review.baseline.nodes = [makeNode('a', 0, 0), makeNode('b', 600, 360), makeNode('c', 0, 360)]
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok()).toBeTruthy()
  const session: ReviewSession = await created.json()
  await page.goto(`/?session=${session.id}`)
  const paths = page.locator('.react-flow__edge-path')
  for (const baseline of [false, true]) {
    if (baseline) await page.getByRole('button', { name: '基线 B', exact: true }).click()
    await expect(paths).toHaveCount(2)
    const orthogonal = () => paths.evaluateAll(elements => elements.flatMap(element => {
      const failures: string[] = []
      let previous = { x: 0, y: 0 }
      for (const [, kind, coordinates] of (element.getAttribute('d') ?? '').matchAll(/([MLQ])([^MLQ]+)/g)) {
        const values = coordinates.trim().split(/[\s,]+/).map(Number)
        const next = { x: values.at(-2)!, y: values.at(-1)! }
        if (kind === 'L' && Math.abs(next.x - previous.x) > 1e-5 && Math.abs(next.y - previous.y) > 1e-5) failures.push(`${previous.x},${previous.y}->${next.x},${next.y}`)
        previous = next
      }
      return failures
    }))
    await expect.poll(orthogonal).toEqual([])
    const branch = page.locator('.react-flow__node[data-id="a"]')
    await branch.hover()
    await expect.poll(orthogonal).toEqual([])
    await branch.click()
    await expect.poll(orthogonal).toEqual([])
  }
})

test('each round restores its zoom and reading position when a discussion dialog is reopened', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const { session, commentId } = await twoRoundSession(request)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?session=${session.id}`)
  const canvas = page.getByLabel('业务流程画布', { exact: true })
  const current = page.getByRole('button', { name: '当前 R2', exact: true })
  const before = page.getByRole('button', { name: '修改前 R1', exact: true })
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  await expect(current).toHaveAttribute('aria-pressed', 'true')
  expect((await canvasLayout(page)).visibleHeight).toBeGreaterThanOrEqual(770)
  await expect(page.locator('.graph-toolbar')).toHaveCSS('height', '44px')
  const badge = page.getByRole('button', { name: '讨论：订阅服务是否可用？（1 条）', exact: true })
  const original = await viewport(page)
  await badge.click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  const thread = discussion.locator(`#discussion-thread-${commentId}`)
  await expect(thread).toHaveClass(/is-active/)
  await expect(thread).toContainText('第二轮已同步规则，请核对当前图与原始意见。')
  await expect.poll(() => viewport(page)).toEqual(original)
  const initial = await viewport(page)
  await page.getByRole('button', { name: '放大流程', exact: true }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(initial.zoom * 1.2, 3)
  const bounds = await canvas.boundingBox()
  await page.mouse.move(bounds!.x + 24, bounds!.y + 250)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + 54, bounds!.y + 100, { steps: 10 })
  await page.mouse.up()
  const reading = await viewport(page)
  expect(reading.y).toBeLessThan(initial.y - 80)
  await before.click()
  await expect(canvas).toHaveAttribute('data-readonly', 'true')
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  await badge.click()
  await expect(thread).toHaveClass(/is-active/)
  await expect(thread).toBeVisible()
  await expect(thread).toContainText('跨轮核对关闭功能时的拒绝出口。')
  await expect(thread.getByRole('button', { name: '回复讨论', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '缩小流程', exact: true }).click()
  await current.click()
  await expect(canvas).not.toHaveAttribute('data-readonly', 'true')
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(reading.zoom, 3)
  await expect.poll(async () => Math.abs((await viewport(page)).x - reading.x)).toBeLessThanOrEqual(1)
  await expect.poll(async () => Math.abs((await viewport(page)).y - reading.y)).toBeLessThanOrEqual(1)
  await badge.click()
  await expect(thread).toHaveClass(/is-active/)
  await expect(thread).toContainText('第二轮已同步规则，请核对当前图与原始意见。')
  await expect(thread.getByRole('button', { name: '回复讨论', exact: true })).toBeEnabled()
  expect(errors).toEqual([])
})

test('mobile revision controls preserve canvas space and remain usable in system light and dark themes', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const { session } = await twoRoundSession(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`/?session=${session.id}`)
  const canvas = page.getByLabel('业务流程画布', { exact: true })
  const current = page.getByRole('button', { name: '当前 R2', exact: true })
  const before = page.getByRole('button', { name: '修改前 R1', exact: true })
  const tools = page.locator('summary[aria-label="画布工具"]')
  const openTools = async () => {
    if (!(await tools.evaluate(element => element.closest('details')?.open))) await tools.click()
  }
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  const light = await canvas.evaluate(element => getComputedStyle(element).backgroundColor)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('.react-flow')).toHaveClass(new RegExp(`\\b${colorScheme}\\b`))
    if (colorScheme === 'dark') await expect.poll(() => canvas.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(light)
    await openTools()
    await expect(current).toHaveAttribute('aria-pressed', 'true')
    await expect(before).toBeInViewport({ ratio: 1 })
    await expect(current).toBeInViewport({ ratio: 1 })
    const currentLayout = await canvasLayout(page)
    expect(currentLayout.pageWidth).toBeLessThanOrEqual(390)
    expect(currentLayout.pageHeight).toBeLessThanOrEqual(845)
    expect(currentLayout.visibleHeight).toBeGreaterThanOrEqual(570)
    expect(currentLayout.bottom).toBeLessThanOrEqual(845)
    await before.click()
    await openTools()
    await expect(before).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas).toHaveAttribute('data-readonly', 'true')
    await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
    const historicalLayout = await canvasLayout(page)
    expect(historicalLayout.pageWidth).toBeLessThanOrEqual(390)
    expect(historicalLayout.pageHeight).toBeLessThanOrEqual(845)
    expect(historicalLayout.visibleHeight).toBeGreaterThanOrEqual(570)
    expect(historicalLayout.bottom).toBeLessThanOrEqual(845)
    await tools.click()
    await expect(current).not.toBeVisible()
    const returnToCurrent = page.getByRole('button', { name: '返回当前 R2', exact: true })
    await expect(returnToCurrent).toBeInViewport({ ratio: 1 })
    await returnToCurrent.click()
    await openTools()
    await expect(current).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas).not.toHaveAttribute('data-readonly', 'true')
  }
  expect(errors).toEqual([])
})
