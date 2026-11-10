import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page, Response } from '@playwright/test'
import { createHash } from 'node:crypto'
import { addComment } from '../src/model.ts'
import type { ReviewSession } from '../src/session-types.ts'
import type { Evidence, ReviewDocument } from '../src/types.ts'
import { contextReview } from './fixtures/context-review.ts'
import { openMenu } from './ui.ts'

// Run with the Go E2E runner, against its disposable session store and packaged UI.

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cacheStatuses = ['miss', 'memory', 'disk', 'shared']
const reference = ({ path, symbol, startLine, endLine, digest }: Evidence) => ({ path, symbol, startLine, endLine, digest })
const modes = [
  { name: 'short unified', lines: 194, split: false },
  { name: 'virtual unified', lines: 1998, split: false },
  { name: 'side by side', lines: 194, split: true },
]
interface DiffResult {
  key: string
  algorithm: string
  schemaVersion: number
  coordinate: string
  before: { digest: string; length: number }
  after: { digest: string; length: number }
  precise: boolean
  changes: { fromA: number; toA: number; fromB: number; toB: number }[]
}
interface PlanNode { id: string; kind: string; position: { x: number; y: number }; title: string; summary: string }
interface LayoutInput {
  nodes: PlanNode[]
  edges: { id: string; source: string; target: string; label: string }[]
  reference?: { nodes: PlanNode[]; edges: LayoutInput['edges'] }
  sizes: { id: string; width: number; height: number }[]
}
interface LayoutResult {
  key: string
  nodes: Record<string, { position: { x: number; y: number }; width: number; height: number }>
  edges: Record<string, { points: { x: number; y: number }[]; label: { x: number; y: number } }>
}

async function createSession(request: APIRequestContext, review = contextReview(194)) {
  const capabilities = await request.get('/api/precompute')
  expect(capabilities.ok(), 'Build the current Go backend before running this suite').toBe(true)
  expect(await capabilities.json()).toMatchObject({ schemaVersion: 1, coordinate: 'utf16' })
  const response = await request.post('/api/review-sessions', { data: { review } })
  expect(response.ok(), await response.text()).toBe(true)
  return await response.json() as ReviewSession
}

async function result<T>(response: Response): Promise<T> {
  expect(response.request().method()).toBe('POST')
  expect(response.ok(), await response.text()).toBe(true)
  expect(cacheStatuses).toContain(response.headers()['x-logic-margin-cache'])
  return await response.json() as T
}

function assertDiff(value: DiffResult, before: Evidence, after: Evidence) {
  const a = before.code!, b = after.code!
  expect(value).toMatchObject({ schemaVersion: 1, coordinate: 'utf16',
    before: { digest: hash(a), length: a.length }, after: { digest: hash(b), length: b.length } })
  expect(value.key).toMatch(/^[a-f0-9]{64}$/)
  let fromA = 0, fromB = 0
  const boundary = (text: string, at: number) => at === 0 || at === text.length ||
    !(/[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]))
  for (const change of value.changes) {
    expect(Object.values(change).every(Number.isSafeInteger)).toBe(true)
    expect(change.fromA).toBeGreaterThanOrEqual(fromA)
    expect(change.toA).toBeGreaterThanOrEqual(change.fromA)
    expect(change.toA).toBeLessThanOrEqual(a.length)
    expect(change.fromB).toBeGreaterThanOrEqual(fromB)
    expect(change.toB).toBeGreaterThanOrEqual(change.fromB)
    expect(change.toB).toBeLessThanOrEqual(b.length)
    expect(boundary(a, change.fromA) && boundary(a, change.toA) && boundary(b, change.fromB) && boundary(b, change.toB)).toBe(true)
    expect(a.slice(fromA, change.fromA)).toBe(b.slice(fromB, change.fromB))
    fromA = change.toA; fromB = change.toB
  }
  expect(a.slice(fromA)).toBe(b.slice(fromB))
}

function assertLayoutInput(input: LayoutInput) {
  expect(Object.keys(input).sort()).toEqual(input.reference ? ['edges', 'nodes', 'reference', 'sizes'] : ['edges', 'nodes', 'sizes'])
  for (const graph of [input, ...(input.reference ? [input.reference] : [])]) {
    for (const node of graph.nodes) expect(Object.keys(node).sort()).toEqual(['id', 'kind', 'position', 'summary', 'title'])
    for (const edge of graph.edges) expect(Object.keys(edge).sort()).toEqual(['id', 'label', 'source', 'target'])
  }
  for (const size of input.sizes) expect(Object.keys(size).sort()).toEqual(['height', 'id', 'width'])
}

async function openCode(page: Page, split = false) {
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
  await page.locator('.resize-right').focus()
  await page.keyboard.press('End')
  await panel.getByRole('button', { name: split ? '并排' : '统一', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveCount(split ? 2 : 1)
  return panel
}

async function position(node: Locator) {
  return node.evaluate(element => {
    const matrix = new DOMMatrixReadOnly((element as HTMLElement).style.transform)
    return { x: matrix.e, y: matrix.f }
  })
}

for (const mode of modes) test(`${mode.name}: saved-source POST, ranges and reading state survive UI updates`, async ({ page, request }) => {
  const session = await createSession(request, contextReview(mode.lines))
  const path = `/api/review-sessions/${session.id}`
  const calls: { url: string; input: unknown; stage: string }[] = [], errors: string[] = []
  let stage = 'initial'
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/\/precompute\/(diff|layout)$/.test(new URL(request.url()).pathname)) calls.push({ url: request.url(), input: request.postDataJSON(), stage }) })
  const pending = page.waitForResponse(response => response.url().endsWith(`${path}/precompute/diff`))
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page, mode.split)
  const response = await pending
  const before = session.review.baseline!.nodes[0].evidence[0], after = session.review.nodes[0].evidence[0]
  expect(response.request().postDataJSON()).toEqual({ beforeSnapshot: { kind: 'baseline' }, afterSnapshot: { kind: 'round', round: 1 },
    before: reference(before), after: reference(after) })
  assertDiff(await result<DiffResult>(response), before, after)
  const editors = panel.locator('.cm-editor'), overview = panel.locator('.code-overview')
  await expect.poll(() => overview.locator('.is-added').count()).toBeGreaterThan(0)
  await expect.poll(() => overview.locator('.is-removed').count()).toBeGreaterThan(0)
  if (!mode.split) await expect(editors).toHaveClass(/cm-unified-virtual/)
  else await expect(editors.first()).not.toHaveClass(/cm-unified-virtual/)
  await editors.evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).dataset.precomputeIdentity = 'retained' }))
  const gap = editors.first().locator('[data-fold-id="1"]')
  const originalCount = Number(await gap.getAttribute('data-line-count'))
  expect(originalCount).toBeGreaterThan(40)
  await gap.locator('[data-context-edge="start"]').click()
  await expect(gap).toHaveAttribute('data-line-count', String(originalCount - 20))
  const scroll = panel.locator(mode.split ? '.cm-mergeView' : '.cm-scroller').first()
  const slider = overview.getByRole('slider')
  await slider.press('End')
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  await slider.press('Home')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0)
  // Let geometry requests settle before checking that discussion/UI-only changes do no work.
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const count = calls.length
  stage = 'annotation'
  const changed = addComment(session.review, [{ kind: 'node', id: 'sparse' }], '验收：新增批注不使代码或几何缓存失效。')
  const poll = page.waitForResponse(response => new URL(response.url()).pathname === path && response.url().includes('afterVersion=') && response.ok())
  const saved = await request.post(`${path}/mutations`, { data: { round: session.round, revision: session.review.revision,
    fingerprint: session.review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment: changed.comments.at(-1) }] } })
  expect(saved.ok(), await saved.text()).toBe(true)
  await poll
  await expect(page.locator('.canvas-caption')).toContainText('1 条待处理意见')
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(calls).toHaveLength(count)
  stage = 'language'
  const menu = await openMenu(page, '.appearance-menu')
  await menu.locator('#interface-language button[value="en"]').click()
  await page.keyboard.press('Escape')
  await expect(gap.locator('[data-context-edge="start"]')).toHaveAccessibleName(/Expand \d+ lines below/)
  await expect(gap).toHaveAttribute('data-line-count', String(originalCount - 20))
  await panel.getByRole('button', { name: 'Expand all', exact: true }).click()
  await expect(panel.locator('.code-context-fold')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Collapse unchanged', exact: true }).click()
  await expect(gap).toHaveAttribute('data-line-count', String(originalCount))
  for (const editor of await editors.all()) await expect(editor).toHaveAttribute('data-precompute-identity', 'retained')
  const initialLayout = calls.slice(0, count).filter(call => call.url.endsWith('/precompute/layout')).at(-1)!.input as LayoutInput
  for (const call of calls.slice(count)) {
    expect(call.stage).toBe('language')
    expect(call.url).toMatch(/\/precompute\/layout$/)
    const input = call.input as LayoutInput
    // Translation can change node height; only the measured sizes may invalidate layout.
    expect({ ...input, sizes: [] }).toEqual({ ...initialLayout, sizes: [] })
    expect(input.sizes).not.toEqual(initialLayout.sizes)
  }
  expect(errors).toEqual([])
})

for (const mode of modes) test(`${mode.name}: consumes backend ranges rather than recomputing local chunks`, async ({ page, request }) => {
  const session = await createSession(request, contextReview(mode.lines))
  const before = session.review.baseline!.nodes[0].evidence[0], after = session.review.nodes[0].evidence[0]
  let observed = false
  await page.route(`**/api/review-sessions/${session.id}/precompute/diff`, async route => {
    const response = await route.fetch()
    expect(response.ok(), await response.text()).toBe(true)
    expect(cacheStatuses).toContain(response.headers()['x-logic-margin-cache'])
    const original = await response.json() as DiffResult
    assertDiff(original, before, after)
    observed = true
    // A valid deliberately coarse result is distinguishable from the fixture's two local chunks.
    await route.fulfill({ response, json: { ...original, precise: false,
      changes: [{ fromA: 0, toA: before.code!.length, fromB: 0, toB: after.code!.length }] } })
  })
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page, mode.split)
  expect(observed).toBe(true)
  await expect(panel.locator('.code-editor-tools > [role="status"]').first()).toHaveText('1 处差异')
  await expect(panel.locator('.code-context-fold')).toHaveCount(0)
  await expect.poll(() => panel.locator('.code-overview .is-added').count()).toBeGreaterThan(0)
  await expect.poll(() => panel.locator('.code-overview .is-removed').count()).toBeGreaterThan(0)
})

function nextRound(state: ReviewSession): ReviewDocument {
  const next = structuredClone(state.review)
  const round = state.round + 1
  next.revision = `precompute-R${round}`
  next.nodes[0].title = `后端布局 R${round}`
  const evidence = next.nodes[0].evidence[0]
  evidence.code = evidence.code!.replace(/changed_(first|round\d+)\(\);/, `changed_round${round}();`)
  evidence.digest = hash(evidence.code)
  const files = [{ path: evidence.path, sha256: hash(`${'// preceding context\n'.repeat(100)}${evidence.code}`) }]
  next.snapshot = { ...next.snapshot, files, fingerprint: hash(JSON.stringify(files)) }
  return next
}

async function publish(request: APIRequestContext, state: ReviewSession) {
  const review = nextRound(state)
  const response = await request.post(`/api/review-sessions/${state.id}/revise`, { data: {
    expectedVersion: state.version, review, publication: { baseRound: state.round, summary: '固定保存的测试版本',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: '2026-11-09T00:00:00.000Z', files: review.snapshot.files,
        fingerprint: review.snapshot.fingerprint } },
  } })
  expect(response.ok(), await response.text()).toBe(true)
  return await response.json() as ReviewSession
}

test('graph consumes backend coordinates, rekeys measured dimensions and keeps B/R history separate', async ({ page, request }) => {
  const review = contextReview(194)
  review.nodes[0].title = '后端布局 R1'
  review.baseline!.nodes[0].title = '后端布局 B'
  for (const document of [review, review.baseline!]) {
    document.nodes.push({ ...structuredClone(document.nodes[0]), id: 'terminal', kind: 'result', title: '完成',
      summary: '固定测试终点', position: { x: 0, y: 400 }, evidence: [] })
    document.edges = [{ id: 'backend-flow', sceneId: document.nodes[0].sceneId, source: 'sparse', target: 'terminal', label: '完成', detail: '固定布局测试连线' }]
  }
  const first = await createSession(request, review), second = await publish(request, first), third = await publish(request, second)
  const replies: { input: LayoutInput; value: LayoutResult }[] = []
  await page.route(`**/api/review-sessions/${third.id}/precompute/layout`, async route => {
    const input = route.request().postDataJSON() as LayoutInput
    assertLayoutInput(input)
    const response = await route.fetch()
    expect(response.ok(), await response.text()).toBe(true)
    expect(cacheStatuses).toContain(response.headers()['x-logic-margin-cache'])
    const value = await response.json() as LayoutResult
    // An observable translation proves GraphCanvas uses the HTTP coordinates, including on revisits.
    for (const node of Object.values(value.nodes)) node.position.x += 137
    for (const edge of Object.values(value.edges)) {
      for (const point of edge.points) point.x += 137
      edge.label.x += 137
    }
    replies.push({ input, value })
    await route.fulfill({ response, json: value })
  })
  const node = page.locator('.react-flow__node[data-id="sparse"]')
  const ready = async (title: string) => {
    await expect(node).toContainText(title)
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await expect.poll(async () => {
      const current = replies.filter(item => item.input.nodes[0].title === title).at(-1)
      return !!current && JSON.stringify(await position(node)) === JSON.stringify(current.value.nodes.sparse.position)
    }).toBe(true)
    await expect(page.locator('.react-flow__edge[data-id="backend-flow"]')).toHaveCount(1)
  }
  await page.goto(`/?session=${third.id}`)
  await expect.poll(() => replies.some(item => item.input.nodes[0].title === '后端布局 R3' && item.input.sizes.length > 0)).toBe(true)
  await ready('后端布局 R3')
  const original = replies.filter(item => item.input.nodes[0].title === '后端布局 R3' && item.input.sizes.length > 0).at(-1)!
  await page.addStyleTag({ content: '.react-flow__node[data-id="sparse"], .react-flow__node[data-id="sparse"] .review-node { width: 410px !important; }' })
  await expect.poll(() => replies.some(item => item.input.sizes.some(size => size.id === 'sparse' && size.width === 410))).toBe(true)
  const resized = replies.filter(item => item.input.sizes.some(size => size.width === 410)).at(-1)!
  expect(resized.value.key).not.toBe(original.value.key)
  await ready('后端布局 R3')
  await openMenu(page, '.canvas-tools')
  await page.getByRole('button', { name: '基线 B', exact: true }).click()
  await expect.poll(() => replies.some(item => item.input.nodes[0].title === '后端布局 B')).toBe(true)
  await ready('后端布局 B')
  await openMenu(page, '.canvas-tools')
  await page.getByRole('button', { name: '当前 R3', exact: true }).click()
  await ready('后端布局 R3')
  await openMenu(page, '.canvas-tools')
  await page.getByLabel('比较依据', { exact: true }).selectOption('previous')
  await page.getByRole('button', { name: '修改前 R2', exact: true }).click()
  await expect.poll(() => replies.some(item => item.input.nodes[0].title === '后端布局 R2')).toBe(true)
  await ready('后端布局 R2')
  const historical = replies.filter(item => item.input.nodes[0].title === '后端布局 R2').at(-1)!
  expect(historical.value.key).not.toBe(resized.value.key)
  expect(historical.input.reference?.nodes[0].title).toBe('后端布局 R3')
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/review-sessions/${third.id}/precompute/diff`))
  const panel = await openCode(page)
  const response = await pending
  // Latest publication.baseRound is 2; historical R2's actual preceding source is R1.
  expect(response.request().postDataJSON()).toEqual({ beforeSnapshot: { kind: 'round', round: 1 }, afterSnapshot: { kind: 'round', round: 2 },
    before: reference(first.review.nodes[0].evidence[0]), after: reference(second.review.nodes[0].evidence[0]) })
  assertDiff(await result<DiffResult>(response), first.review.nodes[0].evidence[0], second.review.nodes[0].evidence[0])
  await expect(panel.locator('.cm-line').filter({ hasText: /^changed_round2\(\);$/ })).toHaveCount(1)
  await expect(panel.locator('.cm-line').filter({ hasText: /^changed_round3\(\);$/ })).toHaveCount(0)
})

test('local file import never uploads source, graph or comments to a session/precompute endpoint', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/api/precompute' || path.startsWith('/api/review-sessions')) requests.push(`${request.method()} ${path}`)
  })
  await page.goto('/')
  const review = contextReview(194)
  review.id = 'backend-private-local-import'
  review.baseline!.id = review.id
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'backend-local.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  await expect(page.getByRole('heading', { name: review.title, exact: true })).toBeVisible()
  const panel = await openCode(page)
  await expect(panel.locator('.code-overview .is-added')).toHaveCount(2)
  await expect(panel.locator('.code-context-fold')).not.toHaveCount(0)
  expect(requests).toEqual([])
})

for (const fallback of ['legacy Node 404', 'computation 503', 'offline'] as const) test(`${fallback}: saved code and layout use the local fallback`, async ({ page, request }) => {
  const session = await createSession(request)
  const errors: string[] = [], intercepted: string[] = [], failed: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => failed.push(new URL(request.url()).pathname))
  // Emulate the old Node capability response while keeping session storage and sources real.
  if (fallback === 'legacy Node 404') await page.route('**/api/precompute', route => {
    intercepted.push(route.request().url())
    return route.fulfill({ status: 404, json: { error: 'not found' } })
  })
  if (fallback === 'computation 503') await page.route('**/precompute/*', route => {
    intercepted.push(route.request().url())
    return route.fulfill({ status: 503, json: { error: 'unavailable' } })
  })
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  // Go offline after the lazy editor bundle loads, before its first computation can complete.
  if (fallback === 'offline') await page.route(`**/api/review-sessions/${session.id}/precompute/diff`, async route => {
    await page.context().setOffline(true)
    await route.abort('internetdisconnected')
  })
  try {
    const panel = await openCode(page)
    await expect.poll(() => panel.locator('.code-overview .is-added').count()).toBeGreaterThan(0)
    await expect.poll(() => panel.locator('.code-overview .is-removed').count()).toBeGreaterThan(0)
    await expect(panel.locator('.cm-line').filter({ hasText: /^changed_first\(\);$/ })).toHaveCount(1)
    const gap = panel.locator('[data-fold-id="1"]').first()
    const count = Number(await gap.getAttribute('data-line-count'))
    await gap.locator('[data-context-edge="start"]').click()
    await expect(gap).toHaveAttribute('data-line-count', String(count - 20))
    await page.addStyleTag({ content: '.react-flow__node[data-id="sparse"], .react-flow__node[data-id="sparse"] .review-node { width: 395px !important; }' })
    if (fallback === 'offline') {
      await expect.poll(() => failed.some(path => path.endsWith('/precompute/diff'))).toBe(true)
      await expect.poll(() => failed.some(path => path.endsWith('/precompute/layout'))).toBe(true)
    } else if (fallback === 'computation 503') {
      expect(intercepted.some(url => url.endsWith('/precompute/diff'))).toBe(true)
      expect(intercepted.some(url => url.endsWith('/precompute/layout'))).toBe(true)
    } else expect(intercepted.length).toBeGreaterThan(0)
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await expect.poll(() => page.locator('.react-flow__node[data-id="sparse"]').evaluate(element => element.getBoundingClientRect().width > 0)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    if (fallback === 'offline') await page.context().setOffline(false)
  }
})

test('an editor chunk failure stays in the code pane and a reload can recover it', async ({ page, request }) => {
  const session = await createSession(request)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/assets/CodeDiffEditor-*.js', route => route.abort('failed'))
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText('代码视图暂时无法打开，请刷新页面后重试。')
  await panel.getByRole('tab', { name: '详情', exact: true }).click()
  await expect(panel.getByRole('tab', { name: '详情', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.react-flow__node[data-id="sparse"]')).toHaveClass(/selected/)
  expect(errors).toEqual([])
  await page.unroute('**/assets/CodeDiffEditor-*.js')
  await page.reload()
  await openCode(page)
  expect(errors).toEqual([])
})
