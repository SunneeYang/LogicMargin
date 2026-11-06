import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewDocument } from '../src/types.ts'

function focusedReview(): ReviewDocument {
  const review = structuredClone(sampleReview)
  review.id = 'graph-focus-fixture'
  review.scenes = [{ id: 'flow', title: '多阶段调度', description: '' }]
  review.nodes = ['start', 'guard', 'read', 'collect', 'choose', 'upload', 'finish', 'done', 'failed', 'stale'].map(id => ({
    id, sceneId: 'flow', title: id, summary: `核对 ${id} 的当前业务规则。`, detail: '', input: '', output: '',
    kind: id === 'failed' ? 'failure' : id === 'stale' || id === 'done' ? 'result' : 'action',
    position: { x: 0, y: 0 }, evidence: [],
  }))
  review.edges = [
    ['start-guard', 'start', 'guard', '开始调度'], ['guard-read', 'guard', 'read', '有效读取'],
    ['guard-upload', 'guard', 'upload', '有效上传'], ['guard-finish', 'guard', 'finish', '有效收尾'],
    ['read-collect', 'read', 'collect', '处理有效记录'], ['read-failed', 'read', 'failed', '来源读取失败'],
    ['read-stale', 'read', 'stale', '读取回执过期'], ['collect-guard', 'collect', 'guard', '继续下一来源'],
    ['collect-choose', 'collect', 'choose', '全部来源读取完成'], ['choose-guard', 'choose', 'guard', '调度上传'],
    ['choose-empty', 'choose', 'guard', '无候选直接收尾'], ['upload-guard', 'upload', 'guard', '处理上传回执'],
    ['finish-done', 'finish', 'done', '完成'], ['finish-failed', 'finish', 'failed', '收尾失败'],
    ['finish-stale', 'finish', 'stale', '收尾回执过期'],
  ].map(([id, source, target, label]) => ({ id, source, target, label, sceneId: 'flow', detail: `${label}，保留此连接的独立批注目标。` }))
  review.comments = []
  return addComment(review, [{ kind: 'node', id: 'read' }], '核对这个读取步骤。')
}

const camera = (page: Page) => page.locator('.react-flow__viewport').evaluate(element => {
  const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform)
  return { x: transform.e, y: transform.f, zoom: transform.a }
})

for (const width of [1440, 390]) test(`related flow preserves discussion drafts, original edge identities and the complete camera at ${width}px`, async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.text().includes('[React Flow]')) errors.push(message.text()) })
  await page.setViewportSize({ width, height: 1000 })
  await page.goto('/')
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'focus.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(focusedReview())) })
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '显示完整流程', exact: true }).click()
  await page.locator('.react-flow__node[data-id="read"] .node-title').click()
  await page.getByRole('button', { name: '讨论：read（1 条）', exact: true }).click()
  await page.locator('[data-composer] .comment-card').last().getByRole('button', { name: '回复讨论', exact: true }).click()
  await page.getByLabel('补充说明', { exact: true }).fill('聚焦时保留原来的回复草稿。')
  await page.getByRole('button', { name: '收起回复', exact: true }).click()
  const complete = await camera(page)
  await page.getByRole('button', { name: '聚焦关联流程', exact: true }).click()
  await expect(page.locator('.canvas')).toHaveAttribute('data-reading-focus', 'related')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await expect(page.getByRole('dialog', { name: '节点讨论', exact: true })).toContainText('核对这个读取步骤。')
  await page.screenshot({ path: info.outputPath(`related-flow-${width}.png`) })
  await page.locator('.canvas-boundary-connections > summary').click()
  await page.getByRole('button', { name: '展开并定位连接：全部来源读取完成', exact: true }).click()
  const originalEdge = page.locator('.react-flow__edge[data-id="collect-choose"]')
  await expect(originalEdge).toHaveClass(/selected/)
  await expect(page.locator('.react-flow__node[data-id="choose"]')).toBeVisible()
  await page.getByRole('button', { name: '返回完整图', exact: true }).click()
  await expect(page.locator('.canvas')).not.toHaveAttribute('data-reading-focus')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.react-flow__node')).toHaveCount(10)
  await expect.poll(() => camera(page)).toEqual(complete)
  await page.locator('[data-composer] .comment-card').last().getByRole('button', { name: '回复讨论', exact: true }).click()
  await expect(page.getByLabel('补充说明', { exact: true })).toHaveValue('聚焦时保留原来的回复草稿。')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  expect(errors).toEqual([])
})

test('comparison sides restore the same local scope and clear it together when returning to the full graph', async ({ page }) => {
  const review = focusedReview()
  const baseline = structuredClone(review)
  baseline.comments = []
  baseline.revision = 'fixed-baseline'
  baseline.snapshot.fingerprint = 'b'.repeat(64)
  baseline.nodes = baseline.nodes.filter(node => node.id !== 'choose')
  baseline.edges = baseline.edges.filter(edge => edge.source !== 'choose' && edge.target !== 'choose')
  review.baseline = baseline
  review.nodes.find(node => node.id === 'read')!.summary = '修改后的读取规则，核对当前数据。'
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.text().includes('[React Flow]')) errors.push(message.text()) })
  await page.goto('/')
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'comparison-focus.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '显示完整流程', exact: true }).click()
  const read = page.locator('.react-flow__node[data-id="read"]')
  await read.locator('.node-title').click()
  const complete = await camera(page)
  await page.getByRole('button', { name: '聚焦关联流程', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await page.locator('.canvas-boundary-connections > summary').click()
  await page.getByRole('button', { name: '展开并定位连接：全部来源读取完成', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  await page.locator('.canvas-boundary-connections > summary').click()
  await read.locator('.node-title').click()
  const position = await read.getAttribute('style')
  await page.getByRole('button', { name: '基线 B', exact: true }).click()
  await expect(page.getByRole('button', { name: '基线 B', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.canvas')).toHaveAttribute('data-reading-focus', 'related')
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await expect(read).toHaveAttribute('style', position!)
  await page.getByRole('button', { name: '修改后', exact: true }).click()
  await expect(page.getByRole('button', { name: '修改后', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.canvas')).toHaveAttribute('data-reading-focus', 'related')
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  await expect(read).toHaveAttribute('style', position!)
  await page.getByRole('button', { name: '返回完整图', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(10)
  await expect.poll(() => camera(page)).toEqual(complete)
  await page.getByRole('button', { name: '基线 B', exact: true }).click()
  await expect(page.locator('.canvas')).not.toHaveAttribute('data-reading-focus')
  await expect(page.locator('.react-flow__node')).toHaveCount(9)
  expect(errors).toEqual([])
})
