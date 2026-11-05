import { expect, test } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'

test('parallel incoming tracks keep every condition reachable as its own comment target', async ({ page }, info) => {
  const review = structuredClone(sampleReview)
  review.id = 'parallel-incoming-tracks'
  review.scenes = [{ id: 'flow', title: '多来源失败出口', description: '每个失败条件保持独立连接。' }]
  review.nodes = Array.from({ length: 10 }, (_, index) => ({ ...structuredClone(sampleReview.nodes[0]),
    id: `input-${index}`, sceneId: 'flow', title: index === 9 ? '返回错误，保留原结果' : `处理步骤 ${index + 1}`,
    summary: '核对输入，按对应条件继续或结束。', evidence: [], kind: index === 9 ? 'failure' as const : 'action' as const,
    position: { x: index === 9 ? 600 : 0, y: index === 9 ? 880 : index * 220 },
  }))
  review.edges = Array.from({ length: 9 }, (_, index) => ({ id: `exit-${index}`, sceneId: 'flow', source: `input-${index}`, target: 'input-9',
    label: `第 ${index + 1} 步校验失败`, detail: '这条条件可以单独选择和批注。',
  }))
  review.comments = []
  await page.goto('/')
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'tracks.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '显示完整流程', exact: true }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(9)
  for (const edge of review.edges) {
    const path = page.locator(`.react-flow__edge[data-id="${edge.id}"] .react-flow__edge-path`)
    const point = await path.evaluate((element, id) => {
      const curve = element as SVGPathElement, matrix = curve.getScreenCTM()!
      for (let fraction = .1; fraction < .95; fraction += .05) {
        const position = curve.getPointAtLength(curve.getTotalLength() * fraction).matrixTransform(matrix)
        if (document.elementFromPoint(position.x, position.y)?.closest('.react-flow__edge')?.getAttribute('data-id') === id) return { x: position.x, y: position.y }
      }
      return null
    }, edge.id)
    expect(point, `${edge.id} needs an independently clickable track`).not.toBeNull()
    await page.mouse.click(point!.x, point!.y)
    await expect(page.locator('.react-flow__edge.selected')).toHaveAttribute('data-id', edge.id)
    await expect(page.locator(`.react-flow__edge[data-id="${edge.id}"]`)).toContainText(edge.label)
    await page.getByRole('button', { name: '清除选择', exact: true }).click()
  }
  await page.screenshot({ path: info.outputPath('parallel-incoming-tracks.png') })
})

test('a complete cyclic flow keeps its entrance first, preserves every condition and fits outer return channels', async ({ page }, info) => {
  const review = structuredClone(sampleReview)
  review.id = 'complete-cyclic-flow'
  review.scenes = [{ id: 'stages', title: '分阶段处理', description: '完整查看阶段、回执和失败出口。' }]
  review.nodes = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(sampleReview.nodes[0]),
    id: `stage-${index}`, sceneId: 'stages', title: index ? `处理步骤 ${index}` : '准备执行',
    summary: '核对本步骤的输入和结果；失败时保留当前状态。', evidence: [],
    kind: index === 10 ? 'failure' as const : index === 9 || index === 11 ? 'result' as const : 'action' as const,
    position: { x: index >= 10 ? 600 : 0, y: index === 10 ? 880 : index === 11 ? 440 : index * 220 },
  }))
  const pairs = [[0, 1], [0, 10], [1, 2], [1, 11], [1, 10], [2, 3], [2, 4], [2, 7], [2, 8], [2, 11],
    [3, 2], [3, 10], [3, 11], [4, 5], [4, 10], [4, 11], [5, 2], [5, 6], [6, 2], [6, 2],
    [7, 7], [7, 2], [7, 2], [7, 11], [8, 2], [8, 9], [8, 10], [8, 11], [10, 0], [9, 0], [2, 10]]
  review.edges = pairs.map(([source, target], index) => ({ id: `condition-${index}`, sceneId: 'stages', source: `stage-${source}`, target: `stage-${target}`,
    label: index % 3 ? '条件通过后继续处理' : '读取失败或当前状态已经改变，结束本次处理', detail: '完整保留本条件与批注目标。',
  }))
  review.comments = []
  review.baseline = structuredClone(review)
  review.baseline.revision = 'original-stage-flow'
  review.baseline.snapshot.fingerprint = 'original-stage-flow'
  review.nodes[4].summary += ' 当前实现增加了再次核对。'
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.text().includes('[React Flow]')) errors.push(message.text()) })
  await page.goto('/')
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'stages.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  const canvas = page.getByLabel('业务流程画布', { exact: true })
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.react-flow__node')).toHaveCount(12)
  await expect(page.locator('.react-flow__edge')).toHaveCount(31)
  await expect(canvas).not.toHaveAttribute('data-reading-focus')
  const position = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`).evaluate(element => {
    const matrix = new DOMMatrixReadOnly(element.style.transform)
    return { x: matrix.e, y: matrix.f }
  })
  const entry = await position('stage-0')
  expect(entry.y).toBeLessThan((await position('stage-9')).y)
  await expect(page.locator('.react-flow__edge.route-return')).not.toHaveCount(0)
  await expect(page.locator('.react-flow__edge.route-exception')).not.toHaveCount(0)
  const wrapped = page.locator('.react-flow__edge[data-id="condition-0"] .react-flow__edge-text tspan')
  await expect(wrapped).not.toHaveCount(1)
  await expect(page.locator('.react-flow__edge[data-id="condition-0"]')).toContainText(review.edges[0].label)
  await page.getByRole('button', { name: '显示完整流程', exact: true }).click()
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('.canvas')!.getBoundingClientRect()
    const labels = [...document.querySelectorAll('.react-flow__edge-textbg')].map(element => element.getBoundingClientRect())
    const nodes = [...document.querySelectorAll('.react-flow__node .review-node')].map(element => element.getBoundingClientRect())
    const overlap = (a: DOMRect, b: DOMRect) => a.left + 1 < b.right && a.right - 1 > b.left && a.top + 1 < b.bottom && a.bottom - 1 > b.top
    return {
      outside: labels.filter(rect => rect.left < canvas.left || rect.right > canvas.right || rect.top < canvas.top || rect.bottom > canvas.bottom).length,
      covered: labels.filter(label => nodes.some(node => overlap(label, node))).length,
      collisions: labels.filter((label, index) => labels.slice(index + 1).some(other => overlap(label, other))).length,
    }
  })).toEqual({ outside: 0, covered: 0, collisions: 0 })
  await page.screenshot({ path: info.outputPath('complete-staged-flow.png') })
  await page.getByRole('button', { name: '基线 B', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.react-flow__edge')).toHaveCount(31)
  await expect(page.locator('.react-flow__node .revision-badge')).toHaveCount(0)
  expect(await position('stage-0')).toEqual(entry)
  await page.getByRole('button', { name: '修改后', exact: true }).click()
  await expect(page.locator('.react-flow__node[data-id="stage-4"]')).toContainText('已修改')
  expect(errors).toEqual([])
})
