import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { ReviewSession } from '../src/session-types.ts'
import type { Evidence } from '../src/types.ts'
import { structuralCases, structuralInput, structuralReadingCase, structuralReview, validateStructuralFixture } from './fixtures/structural-review.ts'
import type { StructuralCase } from './fixtures/structural-review.ts'
import { openMenu } from './ui.ts'

test.skip(process.env.LOGIC_MARGIN_E2E_GO !== '1', 'Requires the current Go runner, structure API and packaged UI')

type Range = { from: number; to: number }
type Highlights = { before: Range[]; after: Range[] }
interface ComputedDiff {
  schemaVersion: number; coordinate: string; algorithm: string; key: string
  before: { digest: string; length: number }; after: { digest: string; length: number }
  precise: boolean; changes: { fromA: number; toA: number; fromB: number; toB: number }[]
}
interface ScopePair { id: string; kind: string; name: string; before: Range; after: Range }
interface StructureResult extends Omit<ComputedDiff, 'precise' | 'changes'> {
  mode: 'structural' | 'text'; language: string; reason?: string; formattingOnly: boolean
  highlights: Highlights; scopes: ScopePair[]
  moves: (ScopePair & { modified: boolean; highlights: Highlights; comparison: ComputedDiff })[]
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cacheStatuses = ['miss', 'memory', 'disk', 'shared']
const modes = [{ name: 'short unified', lines: 194, split: false }, { name: 'virtual unified', lines: 1998, split: false },
  { name: 'side by side', lines: 194, split: true }]
const boundary = (text: string, at: number) => at === 0 || at === text.length ||
  !(/[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]))

function ranges(values: Range[], text: string) {
  let end = 0
  for (const { from, to } of values) {
    expect(Number.isSafeInteger(from) && Number.isSafeInteger(to)).toBe(true)
    expect(from).toBeGreaterThanOrEqual(end)
    expect(to).toBeGreaterThanOrEqual(from)
    expect(to).toBeLessThanOrEqual(text.length)
    expect(boundary(text, from) && boundary(text, to)).toBe(true)
    end = to
  }
}

function metadata(value: ComputedDiff | StructureResult, before: string, after: string) {
  expect(value).toMatchObject({ schemaVersion: 1, coordinate: 'utf16',
    before: { digest: hash(before), length: before.length }, after: { digest: hash(after), length: after.length } })
  expect(value.key).toMatch(/^[a-f0-9]{64}$/)
  expect(value.algorithm.length).toBeGreaterThan(0)
}

function assertDiff(value: ComputedDiff, before: string, after: string) {
  metadata(value, before, after)
  let a = 0, b = 0
  for (const change of value.changes) {
    ranges([{ from: change.fromA, to: change.toA }], before)
    ranges([{ from: change.fromB, to: change.toB }], after)
    expect(change.fromA).toBeGreaterThanOrEqual(a)
    expect(change.fromB).toBeGreaterThanOrEqual(b)
    expect(before.slice(a, change.fromA)).toBe(after.slice(b, change.fromB))
    a = change.toA; b = change.toB
  }
  expect(before.slice(a)).toBe(after.slice(b))
}

function assertStructure(value: StructureResult, sample: StructuralCase) {
  metadata(value, sample.before, sample.after)
  expect(['structural', 'text']).toContain(value.mode)
  expect(typeof value.formattingOnly).toBe('boolean')
  ranges(value.highlights.before, sample.before); ranges(value.highlights.after, sample.after)
  expect(new Set(value.scopes.map(scope => scope.id)).size).toBe(value.scopes.length)
  expect(new Set(value.scopes.map(scope => `${scope.kind}:${scope.name}`)).size).toBe(value.scopes.length)
  for (const scope of value.scopes) {
    expect(scope.id.length > 0 && scope.name.length > 0 && scope.kind.length > 0).toBe(true)
    ranges([scope.before], sample.before); ranges([scope.after], sample.after)
  }
  for (const move of value.moves) {
    expect(value.scopes).toContainEqual({ id: move.id, kind: move.kind, name: move.name, before: move.before, after: move.after })
    const a = sample.before.slice(move.before.from, move.before.to), b = sample.after.slice(move.after.from, move.after.to)
    ranges(move.highlights.before, a); ranges(move.highlights.after, b)
    assertDiff(move.comparison, a, b)
    expect(typeof move.modified).toBe('boolean')
  }
  if (sample.mode) expect(value.mode, `${sample.id}: ${value.reason ?? 'no fallback reason'}`).toBe(sample.mode)
  if (sample.reason) expect(value.reason).toBe(sample.reason)
  if (value.mode === 'text') {
    expect(['unsupported-language', 'invalid-syntax', 'budget', 'syntax-boundary']).toContain(value.reason)
    expect(value.formattingOnly).toBe(false)
    expect(value.moves).toEqual([])
    return
  }
  expect(value.reason).toBeUndefined()
  expect(value.formattingOnly).toBe(sample.formattingOnly)
  if (sample.formattingOnly) expect(value.highlights).toEqual({ before: [], after: [] })
  else if (!sample.moved) expect(value.highlights.before.length + value.highlights.after.length).toBeGreaterThan(0)
  if (sample.noMoves) expect(value.moves).toEqual([])
  if (sample.moved) {
    expect(value.moves.map(move => ({ name: move.name, modified: move.modified }))).toEqual([sample.moved])
    if (!sample.moved.modified) expect(value.moves[0].comparison.changes).toEqual([])
    else expect(value.moves[0].comparison.changes.length).toBeGreaterThan(0)
  }
  if (sample.id === 'ts-semantic' || sample.id.startsWith('ts-reading-')) {
    const equal = sample.after.indexOf('<=') + 1
    expect(value.highlights.after.some(range => range.from <= equal && equal < range.to), 'Highlight the inserted = in <=, even amid formatting').toBe(true)
    for (const token of ['新标签😁', '新注释']) {
      const start = sample.after.indexOf(token)
      expect(value.highlights.after.some(range => range.from < start + token.length && range.to > start), `Preserve changed string/comment ${token}`).toBe(true)
    }
  }
}

async function createSession(request: APIRequestContext, sample = structuralReadingCase()) {
  const capabilities = await request.get('/api/precompute')
  expect(capabilities.ok(), 'Build the current Go backend; an old program is not structure acceptance').toBe(true)
  const caps = await capabilities.json()
  expect(caps).toMatchObject({ schemaVersion: 1, coordinate: 'utf16' })
  expect(typeof caps.structureAlgorithm, 'The Go runner must advertise the integrated structure API').toBe('string')
  expect(caps.structureAlgorithm.length).toBeGreaterThan(0)
  const review = validateStructuralFixture(structuralReview(sample))
  const response = await request.post('/api/review-sessions', { data: { review } })
  expect(response.ok(), await response.text()).toBe(true)
  const session = await response.json() as ReviewSession
  expect(session.review.nodes.map(node => node.id)).toEqual(['sparse', 'alternate'])
  expect(session.review.nodes[0].evidence).toEqual(review.nodes[0].evidence)
  expect(session.review.baseline!.nodes[0].evidence).toEqual(review.baseline!.nodes[0].evidence)
  return session
}

async function openCode(page: Page, split = false, id = 'sparse') {
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator(`.react-flow__node[data-id="${id}"] .node-comment-button`).click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  const dock = panel.getByRole('button', { name: '移到侧栏编辑', exact: true })
  if (await dock.isVisible()) await dock.click()
  await page.locator('.resize-right').focus(); await page.keyboard.press('End')
  if (split) await panel.getByRole('button', { name: '并排', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveCount(split ? 2 : 1)
  return panel
}

function structureButton(panel: Locator) {
  return panel.locator('.code-structure-mode').getByRole('button', { name: /^(结构重点|Structural focus)$/ })
}

for (const sample of structuralCases) test(`API ${sample.id}: saved sources, UTF-16 highlights and conservative pairing`, async ({ request }) => {
  const session = await createSession(request, sample), input = structuralInput(session.review)
  const path = `/api/review-sessions/${session.id}/precompute`
  const rawResponse = await request.post(`${path}/diff`, { data: input })
  expect(rawResponse.ok(), await rawResponse.text()).toBe(true)
  const raw = await rawResponse.json() as ComputedDiff
  assertDiff(raw, sample.before, sample.after)
  expect(raw.changes.length).toBeGreaterThan(0)
  const response = await request.post(`${path}/structure`, { data: input })
  expect(response.ok(), await response.text()).toBe(true)
  expect(cacheStatuses).toContain(response.headers()['x-logic-margin-cache'])
  assertStructure(await response.json() as StructureResult, sample)
  // The independent semantic endpoint must never replace or suppress complete text Changes.
  const again = await request.post(`${path}/diff`, { data: input })
  expect(again.ok(), await again.text()).toBe(true)
  expect(await again.json()).toEqual(raw)
})

test('structure accepts only saved references and snapshot identity', async ({ request }) => {
  const session = await createSession(request), input = structuralInput(session.review)
  const path = `/api/review-sessions/${session.id}/precompute/structure`
  for (const invalid of [{ ...input, before: { ...input.before, digest: '0'.repeat(64) } },
    { ...input, afterSnapshot: { kind: 'round', round: 999 } },
    { ...input, after: { ...input.after, path: 'src/App.tsx' } }]) {
    const response = await request.post(path, { data: invalid })
    expect(response.ok()).toBe(false)
    expect(response.status()).toBeLessThan(500)
  }
})

for (const mode of modes) test(`${mode.name}: consumes injected structure highlights and retains complete text mode`, async ({ page, request }) => {
  const sample = structuralReadingCase(mode.lines), session = await createSession(request, sample)
  let consumed = false
  const input = structuralInput(session.review)
  await page.route(`**/api/review-sessions/${session.id}/precompute/structure`, async route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual(input)
    const response = await route.fetch()
    expect(response.ok(), await response.text()).toBe(true)
    const original = await response.json() as StructureResult
    assertStructure(original, sample)
    const range = (text: string) => ({ from: text.indexOf('accepts'), to: text.indexOf('accepts') + 'accepts'.length })
    consumed = true
    // Legal, deliberately different ranges prove the UI uses the response, not a local parser.
    await route.fulfill({ response, json: { ...original, formattingOnly: false,
      highlights: { before: [range(sample.before)], after: [range(sample.after)] } } })
  })
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page, mode.split)
  await expect(structureButton(panel)).toBeEnabled()
  expect(consumed).toBe(true)
  await expect(panel.locator('.cm-structural-highlight')).toHaveCount(0)
  const rawMarkers = await panel.locator('.code-overview .is-added, .code-overview .is-removed').count()
  expect(rawMarkers).toBeGreaterThan(0)
  await structureButton(panel).click()
  await expect(panel.locator('.cm-structural-added')).toHaveText(['accepts'])
  await expect(panel.locator('.cm-structural-removed')).toHaveText(['accepts'])
  await expect(panel.locator('.cm-structural-highlight')).toHaveCount(2)
  await panel.getByRole('button', { name: '文本差异', exact: true }).click()
  await expect(panel.locator('.cm-structural-highlight')).toHaveCount(0)
  await expect(panel.locator('.code-overview .is-added, .code-overview .is-removed')).toHaveCount(rawMarkers)
  await expect(panel.locator('.cm-content').first()).toContainText('accepts')
})

for (const mode of modes) test(`${mode.name}: late structure preserves reader identity, context, scroll, selection and language`, async ({ page, request }) => {
  const session = await createSession(request, structuralReadingCase(mode.lines))
  let release!: () => void, received = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/review-sessions/${session.id}/precompute/structure`, async route => {
    const response = await route.fetch()
    expect(response.ok(), await response.text()).toBe(true)
    received = true
    await gate
    await route.fulfill({ response })
  })
  try {
    await page.goto(`/?session=${session.id}`)
    const panel = await openCode(page, mode.split), editors = panel.locator('.cm-editor')
    await expect.poll(() => received).toBe(true)
    await editors.evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).dataset.structureIdentity = 'retained' }))
    const gap = editors.first().locator('[data-fold-id="1"]')
    const count = Number(await gap.getAttribute('data-line-count'))
    expect(count).toBeGreaterThan(80)
    for (const edge of ['start', 'end', 'start']) await gap.locator(`[data-context-edge="${edge}"]`).click()
    await expect(gap).toHaveAttribute('data-line-count', String(count - 60))
    const menu = await openMenu(page, '.appearance-menu')
    await menu.locator('#interface-language button[value="en"]').click()
    await menu.locator('summary').click()
    await expect(gap.locator('[data-context-edge="start"]')).toHaveAccessibleName(/Expand \d+ lines below/)
    const scroll = panel.locator(mode.split ? '.cm-mergeView' : '.cm-scroller').first()
    const foldTop = await scroll.evaluate(element => element.scrollTop) + (await gap.boundingBox())!.y - (await scroll.boundingBox())!.y
    await scroll.evaluate(element => { element.scrollTop = 100 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await editors.first().evaluate(element => {
      const bounds = element.querySelector('.cm-scroller')!.getBoundingClientRect()
      const line = [...element.querySelectorAll('.cm-line')].find(item => item.getBoundingClientRect().top >= bounds.top + 10)!
      const range = document.createRange(); range.selectNodeContents(line)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const selected = await page.evaluate(() => window.getSelection()?.toString())
    expect(selected?.length).toBeGreaterThan(0)
    const top = await scroll.evaluate(element => element.scrollTop)
    expect(top).toBeGreaterThan(0)
    release()
    await expect(structureButton(panel)).toBeEnabled()
    for (const editor of await editors.all()) await expect(editor).toHaveAttribute('data-structure-identity', 'retained')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
    expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - top)).toBeLessThan(2)
    await scroll.evaluate((element, top) => { element.scrollTop = top }, foldTop)
    await expect(gap).toHaveAttribute('data-line-count', String(count - 60))
    await expect(gap.locator('[data-context-edge="start"]')).toHaveAccessibleName(/Expand \d+ lines below/)
    await expect(panel.locator('.cm-structural-highlight')).toHaveCount(0)
    await structureButton(panel).click()
    await expect(panel.locator('.code-editor').first()).toHaveAttribute('data-diff-mode', 'structural')
    await expect(gap).toHaveAttribute('data-line-count', String(count - 60))
    for (const editor of await editors.all()) await expect(editor).toHaveAttribute('data-structure-identity', 'retained')
  } finally { release() }
})

test('format-only has a clear label and keeps the full text diff available', async ({ page, request }) => {
  const session = await createSession(request, structuralCases.find(sample => sample.id === 'ts-format')!)
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page)
  await expect(structureButton(panel)).toBeEnabled(); await structureButton(panel).click()
  await expect(panel.getByText('仅排版变化', { exact: true })).toBeVisible()
  await expect(panel.locator('.cm-structural-highlight')).toHaveCount(0)
  await panel.getByRole('button', { name: '文本差异', exact: true }).click()
  expect(await panel.locator('.code-overview .is-added, .code-overview .is-removed').count()).toBeGreaterThan(0)
})

test('a late result for the previous node cannot replace the selected saved node', async ({ page, request }) => {
  const session = await createSession(request)
  let release!: () => void, received = false, delivered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/review-sessions/${session.id}/precompute/structure`, async route => {
    const response = await route.fetch()
    const previous = route.request().postDataJSON().after.symbol === 'sparse'
    if (previous) { received = true; await gate }
    await route.fulfill({ response })
    if (previous) delivered = true
  })
  try {
    await page.goto(`/?session=${session.id}`)
    const first = await openCode(page)
    await expect.poll(() => received).toBe(true)
    await first.getByRole('button', { name: '关闭讨论', exact: true }).click()
    const panel = await openCode(page, false, 'alternate')
    await expect(structureButton(panel)).toBeEnabled()
    await panel.locator('.cm-editor').evaluate(element => { (element as HTMLElement).dataset.structureIdentity = 'alternate' })
    await structureButton(panel).click()
    await expect(panel.locator('.cm-structural-highlight').first()).toBeAttached()
    const marks = await panel.locator('.cm-structural-highlight').allTextContents()
    release()
    await expect.poll(() => delivered).toBe(true)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(panel.locator('.cm-editor')).toHaveAttribute('data-structure-identity', 'alternate')
    await expect(panel.locator('.cm-content')).toContainText('alternate')
    await expect(panel.locator('.cm-content')).not.toContainText('accepts')
    await expect(panel.locator('.cm-structural-highlight')).toHaveText(marks)
  } finally { release() }
})

test('moved code opens the saved slices with original line numbers and no slice upload', async ({ page, request }) => {
  const sample = structuralCases.find(item => item.id === 'go-move-modified')!, session = await createSession(request, sample)
  const input = structuralInput(session.review), calls: unknown[] = []
  const response = await request.post(`/api/review-sessions/${session.id}/precompute/structure`, { data: input })
  expect(response.ok(), await response.text()).toBe(true)
  const value = await response.json() as StructureResult
  assertStructure(value, sample)
  const move = value.moves[0]
  page.on('request', request => { if (/\/precompute\/(diff|structure)$/.test(new URL(request.url()).pathname)) calls.push(request.postDataJSON()) })
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page)
  await expect(structureButton(panel)).toBeEnabled(); await structureButton(panel).click()
  const row = panel.locator('.code-move').filter({ hasText: 'Alpha' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('移动并修改')
  await row.getByRole('button', { name: '与原位置对照', exact: true }).click()
  const local = panel.locator('.code-move-comparison')
  await expect(local).toBeVisible()
  await expect(local.locator('.cm-editor')).toHaveCount(1)
  await local.getByRole('button', { name: '展开全文', exact: true }).click()
  await local.locator('.cm-scroller').first().evaluate(element => { element.scrollTop = 0 })
  await expect(local.locator('.cm-content')).toContainText('函数 Alpha 😀 固定内容')
  const line = (evidence: Evidence, at: number) => evidence.startLine + evidence.code!.slice(0, at).split('\n').length - 1
  const a = line(session.review.baseline!.nodes[0].evidence[0], move.before.from)
  const b = line(session.review.nodes[0].evidence[0], move.after.from)
  await expect(local.locator('.cm-originalLineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${a}$`) })).toHaveCount(1)
  await expect(local.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${b}$`) })).toHaveCount(1)
  await panel.getByRole('button', { name: '并排', exact: true }).click()
  const editors = local.locator('.cm-editor')
  await expect(editors).toHaveCount(2)
  await expect(editors.first().locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${a}$`) })).toHaveCount(1)
  await expect(editors.last().locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${b}$`) })).toHaveCount(1)
  expect(a).not.toBe(b)
  expect(calls.length).toBeGreaterThanOrEqual(2)
  for (const call of calls) expect(call).toEqual(input)
  // Switch to a second saved node; a completed result for Alpha must not attach there.
  await panel.getByRole('button', { name: '关闭讨论', exact: true }).click()
  const alternate = await openCode(page, false, 'alternate')
  await expect(alternate.locator('.code-move')).toHaveCount(0)
  await expect(alternate.locator('.cm-content').first()).toContainText('alternate')
})

for (const id of ['duplicate-name', 'duplicate-body', 'offset-only']) test(`${id}: does not offer an ambiguous or offset-only move`, async ({ page, request }) => {
  const session = await createSession(request, structuralCases.find(sample => sample.id === id)!)
  const pending = page.waitForResponse(response => response.url().endsWith(`/api/review-sessions/${session.id}/precompute/structure`))
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page)
  const response = await pending
  expect(response.ok(), await response.text()).toBe(true)
  const value = await response.json() as StructureResult
  expect(value.moves).toEqual([])
  if (value.mode === 'structural') { await expect(structureButton(panel)).toBeEnabled(); await structureButton(panel).click() }
  await expect(panel.locator('.code-move')).toHaveCount(0)
})

for (const fallback of ['old-capability', 'failed-request', 'text-result', 'invalid-syntax', 'unsupported-language']) test(`${fallback}: preserves ordinary text reading`, async ({ page, request }) => {
  const sample = fallback === 'invalid-syntax' ? structuralCases.find(item => item.id === 'truncated')!
    : fallback === 'unsupported-language' ? structuralCases.find(item => item.id === 'unsupported')! : structuralReadingCase()
  const session = await createSession(request, sample)
  let structureRequests = 0
  page.on('request', request => { if (request.url().endsWith('/precompute/structure')) structureRequests++ })
  if (fallback === 'old-capability') await page.route('**/api/precompute', async route => {
    const response = await route.fetch(), value = await response.json()
    delete value.structureAlgorithm
    await route.fulfill({ response, json: value })
  })
  if (fallback === 'failed-request') await page.route('**/precompute/structure', route => route.fulfill({ status: 503, json: { error: 'fixture-unavailable' } }))
  if (fallback === 'text-result') await page.route('**/precompute/structure', async route => {
    const response = await route.fetch(), value = await response.json() as StructureResult
    await route.fulfill({ response, json: { ...value, mode: 'text', reason: 'budget', formattingOnly: false,
      highlights: { before: [], after: [] }, scopes: [], moves: [] } })
  })
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page)
  await expect(panel.locator('.cm-content').first()).not.toBeEmpty()
  await expect(panel.locator('.cm-structural-highlight')).toHaveCount(0)
  expect(await panel.locator('.code-overview .is-added, .code-overview .is-removed').count()).toBeGreaterThan(0)
  if (fallback !== 'old-capability') {
    await expect.poll(() => structureRequests).toBeGreaterThan(0)
    await expect(panel.getByText(/文本模式/).first()).toBeVisible()
  } else expect(structureRequests).toBe(0)
  await panel.getByRole('button', { name: '并排', exact: true }).click()
  await expect(panel.locator('.cm-editor')).toHaveCount(2)
})

test('late structure in text mode retains the focused overview control', async ({ page, request }) => {
  const session = await createSession(request)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/review-sessions/${session.id}/precompute/structure`, async route => {
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  try {
    await page.goto(`/?session=${session.id}`)
    const panel = await openCode(page)
    const overview = panel.locator('.code-overview-input')
    await expect(overview).toBeEnabled()
    await overview.evaluate(element => { (element as HTMLElement).dataset.structureIdentity = 'retained' })
    await overview.focus()
    release()
    await expect(structureButton(panel)).toBeEnabled()
    await expect(overview).toHaveAttribute('data-structure-identity', 'retained')
    await expect(overview).toBeFocused()
  } finally { release() }
})

test('structure and moved slices validate when browser crypto.subtle is unavailable', async ({ page, request }) => {
  const session = await createSession(request, structuralCases.find(sample => sample.id === 'go-move-modified')!)
  await page.addInitScript(() => Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined }))
  await page.goto(`/?session=${session.id}`)
  const panel = await openCode(page)
  expect(await page.evaluate(() => crypto.subtle)).toBeUndefined()
  await expect(structureButton(panel)).toBeEnabled()
  await structureButton(panel).click()
  await expect(panel.locator('.code-editor').first()).toHaveAttribute('data-diff-mode', 'structural')
  await panel.locator('.code-move').filter({ hasText: 'Alpha' }).getByRole('button', { name: '与原位置对照', exact: true }).click()
  await expect(panel.locator('.code-move-comparison .cm-editor')).toHaveCount(1)
})
