import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { parseReview } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { Evidence, ReviewDocument } from '../src/types.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const reference = (path: string, code: string, line = 27): Evidence => ({ path, symbol: path, code, digest: hash(code), startLine: line, endLine: line + code.split('\n').length - 1 })
const kept = reference('source/kept.ts', 'export const keep = true;')
const added = reference('source/new.ts', 'export const 新版 = "🫠";\n\nexport const enabled = true;\n')
const removed = reference('docs/old.md', 'Previous installation instructions')

function fixture(withBaseline = true): ReviewDocument {
  const build = (current: boolean): ReviewDocument => {
    const nodes = [
      { id: 'added', evidence: current ? [kept, added] : [removed, kept] },
      { id: 'removed', evidence: current ? [] : [removed] },
      { id: 'ambiguous', evidence: [reference('source/repeated.ts', current ? 'new one' : 'old one', 1), reference('source/repeated.ts', current ? 'new two' : 'old two', 9)] },
      { id: 'missing', evidence: [{ ...added, code: undefined }] },
      { id: 'mixed', evidence: current ? [kept, added, reference('source/changed.ts', 'const changed = true;')] : [removed, kept, reference('source/changed.ts', 'const changed = false;')] },
      ...(current ? [{ id: 'new-step', evidence: [added] }] : []),
    ].map((item, index) => ({ ...sampleReview.nodes[0], id: item.id, title: item.id, sceneId: 'associations', position: { x: 0, y: index * 240 }, evidence: item.evidence }))
    const files = [...new Set(nodes.flatMap(node => node.evidence.map(evidence => evidence.path)))].sort().map(path => ({ path, sha256: hash(path) }))
    return { ...sampleReview, id: 'source-associations', revision: current ? 'R1' : 'B', scenes: [{ id: 'associations', title: '代码关联对照', description: '合成材料，验证关联变化不冒充文件新增删除。' }],
      nodes, edges: [], comments: [], snapshot: { ...sampleReview.snapshot, files, fingerprint: hash(JSON.stringify(files)) } }
  }
  return parseReview({ ...build(true), ...(withBaseline ? { baseline: build(false) } : {}) })
}

async function codeTab(page: Page, id: string, locale = 'zh-CN') {
  await page.locator(`.react-flow__node[data-id="${id}"] .node-comment-button`).evaluate(element => (element as HTMLButtonElement).click())
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: locale === 'en' ? 'Code diff' : '代码 diff', exact: true }).click()
  await panel.getByRole('button', { name: locale === 'en' ? 'Unified' : '统一', exact: true }).click()
  return panel
}

for (const locale of ['zh-CN', 'en']) {
  test(`newly linked snippets open before old instructions and render both layouts (${locale})`, async ({ page, request }) => {
    const response = await request.post('/api/review-sessions', { data: { review: fixture() } })
    expect(response.ok(), await response.text()).toBeTruthy()
    const session = await response.json()
    const precomputations: string[] = []
    page.on('request', request => { if (/\/precompute\/(diff|structure)$/.test(request.url())) precomputations.push(request.url()) })
    await page.addInitScript(locale => localStorage.setItem('logic-margin:language', locale), locale)
    await page.goto(`/?session=${session.id}`)
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    const panel = await codeTab(page, 'added', locale)
    const sections = panel.locator('.code-evidence-section')
    await expect(sections.first()).toHaveAttribute('data-code-change', 'added')
    await expect(sections.first()).toHaveAttribute('open', '')
    await expect(sections.first().locator('summary')).toContainText('source/new.ts')
    await expect(panel.locator('.cm-editor')).toHaveCount(1)
    await expect(panel.locator('.cm-changedLine').first()).toHaveText('export const 新版 = "🫠";')
    await expect(panel.locator('.cm-content')).toContainText('export const enabled = true;')
    await expect(panel.locator('.code-evidence-body > .code-diff-note')).toContainText(locale === 'en' ? 'does not establish that the entire file was added' : '不代表整个文件新增')
    await expect(panel.locator('.code-diff-mode')).toContainText(locale === 'en' ? 'Layout' : '布局')
    await expect(panel.getByRole('button', { name: locale === 'en' ? 'Structural focus' : '结构重点', exact: true })).toHaveCount(0)
    await expect(panel.locator('.code-structure-reason')).toContainText(locale === 'en' ? 'one-sided reference' : '无两侧结构可比较')
    await expect(panel.locator('.code-comparison-locations')).toContainText(locale === 'en' ? 'Snippet not linked' : '未关联此片段')
    await expect(panel.locator('.code-comparison-locations')).toContainText('27–30')
    await panel.getByRole('button', { name: locale === 'en' ? 'Side by side' : '并排', exact: true }).click()
    await expect(panel.locator('.cm-editor')).toHaveCount(2)
    await expect(panel.locator('.cm-merge-b .cm-content')).toContainText('export const 新版')
    await expect(panel.locator('.cm-merge-a .cm-content')).toHaveText('')
    await expect(panel.locator('.cm-merge-b .cm-content')).toHaveAttribute('contenteditable', 'false')
    expect(precomputations).toEqual([])
  })
}

test('removed associations render red, while ambiguous and missing evidence keep the saved originals', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: fixture() } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  let panel = await codeTab(page, 'removed')
  await expect(panel.locator('.code-evidence-section')).toHaveAttribute('data-code-change', 'removed')
  await expect(panel.locator('.cm-deletedLine')).toHaveText('Previous installation instructions')
  await expect(panel).toContainText('不代表整个文件删除')
  await panel.getByRole('button', { name: '并排', exact: true }).click()
  await expect(panel.locator('.cm-merge-a .cm-content')).toContainText('Previous installation instructions')
  await expect(panel.locator('.cm-merge-b .cm-content')).toHaveText('')
  panel = await codeTab(page, 'ambiguous')
  await expect(panel.locator('.code-evidence-section')).toHaveCount(4)
  await expect(panel.locator('.cm-editor')).toHaveCount(0)
  await expect(panel).toContainText('两侧片段无法唯一对应')
  panel = await codeTab(page, 'missing')
  await expect(panel.locator('.cm-editor')).toHaveCount(0)
  await expect(panel).toContainText('此版本未保存源码片段')
})

test('real edits take precedence and new nodes still show linked snippet additions', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: fixture() } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  let panel = await codeTab(page, 'mixed')
  await expect(panel.locator('.code-evidence-section').first()).toHaveAttribute('data-code-change', 'changed')
  await expect(panel.locator('.code-evidence-section').first().locator('summary')).toContainText('source/changed.ts')
  panel = await codeTab(page, 'new-step')
  await expect(panel.locator('.code-evidence-section')).toHaveAttribute('data-code-change', 'added')
  await expect(panel.locator('.cm-changedLine').first()).toHaveText('export const 新版 = "🫠";')
})

test('without a baseline, linked source remains an original rather than an inferred addition', async ({ page, request }) => {
  const response = await request.post('/api/review-sessions', { data: { review: fixture(false) } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const session = await response.json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const panel = await codeTab(page, 'new-step')
  await expect(panel.locator('.code-evidence-section')).toHaveAttribute('data-code-change', 'current')
  await expect(panel.locator('.cm-editor')).toHaveCount(0)
  await expect(panel).toContainText('尚未提供比较基线')
})
