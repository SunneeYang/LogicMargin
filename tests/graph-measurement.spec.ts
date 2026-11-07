import { test, expect } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'

test('large scenes and baseline switches settle with every connection and no render loop', async ({ page, request }) => {
  const review = structuredClone(sampleReview)
  review.scenes = review.scenes.slice(0, 2)
  review.nodes = review.scenes.flatMap((scene, sceneIndex) => Array.from({ length: sceneIndex ? 45 : 2 }, (_, index) => ({
    ...review.nodes[0], id: `${scene.id}-${index}`, sceneId: scene.id, title: `测试步骤 ${index + 1}`,
    position: { x: (index % 3) * 360, y: Math.floor(index / 3) * 200 }, evidence: [],
  })))
  review.edges = review.scenes.flatMap(scene => review.nodes.filter(node => node.sceneId === scene.id).slice(1).map((node, index) => ({
    ...review.edges[0], id: `edge-${node.id}`, sceneId: scene.id,
    source: `${scene.id}-${index}`, target: node.id, evidence: [],
  })))
  review.comments = []
  review.baseline = structuredClone(review)
  const sceneId = review.scenes[1].id
  review.baseline.nodes.push({ ...review.nodes.at(-1)!, id: `${sceneId}-45`, position: { x: 0, y: 3000 } })
  review.baseline.edges.push({ ...review.edges.at(-1)!, id: 'baseline-extra', source: `${sceneId}-44`, target: `${sceneId}-45` })
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok()).toBeTruthy()
  const session = await created.json()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.text().includes('[React Flow]')) errors.push(message.text())
  })
  await page.goto(`/?session=${session.id}`)
  const ready = async (nodes: number, edges: number) => {
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await expect(page.locator('.react-flow__node')).toHaveCount(nodes)
    await expect(page.locator('.react-flow__edge')).toHaveCount(edges)
  }
  await ready(2, 1)
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.locator('.scene-button').nth(1).click()
    await ready(45, 44)
    await page.getByRole('button', { name: '基线 B', exact: true }).click()
    await ready(46, 45)
    await page.getByRole('button', { name: '当前 R1', exact: true }).click()
    await ready(45, 44)
    await page.locator('.scene-button').first().click()
    await ready(2, 1)
  }
  expect(errors).toEqual([])
})

test('stationary nodes stop measuring ports after initial layout', async ({ page }) => {
  const review = structuredClone(sampleReview)
  review.nodes = review.nodes.slice(0, 2)
  review.edges = review.edges.filter(edge => review.nodes.some(node => node.id === edge.source)
    && review.nodes.some(node => node.id === edge.target))
  await page.addInitScript(review => {
    localStorage.setItem('logic-margin:active', review.id)
    localStorage.setItem(`logic-margin:review:${review.id}`, JSON.stringify(review))
    const measurements = { active: false, count: 0 }
    Object.assign(window, { measurements })
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      if (measurements.active && this.matches('.react-flow__node')) measurements.count++
      return rect.call(this)
    }
  }, review)
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await expect(page.locator('.react-flow__edge')).toHaveCount(review.edges.length)
  const reads = await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const measurements = Reflect.get(window, 'measurements')
    measurements.active = true
    await new Promise(resolve => setTimeout(resolve, 300))
    measurements.active = false
    return measurements.count
  })
  expect(reads, 'An untouched graph should not keep remeasuring every node on every frame').toBeLessThanOrEqual(2)
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`edge endpoints follow hover and keyboard selection (${reducedMotion})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion })
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const node = page.locator('.react-flow__node[data-id="upgrade-start"]')
  const settleLift = () => node.locator('.review-node').evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })
  const gap = () => page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('.react-flow__edge[data-id="upgrade-start-to-toggle"] .react-flow__edge-path')!
    const point = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!)
    const handle = document.querySelector('.react-flow__node[data-id="upgrade-start"] [data-handleid="source:upgrade-start-to-toggle"]')!.getBoundingClientRect()
    return Math.hypot(point.x - (handle.left + handle.width / 2), point.y - (handle.top + handle.height / 2))
  })
  await expect.poll(gap).toBeLessThan(1.5)
  await node.focus()
  await page.keyboard.press('Enter')
  await expect(node).toHaveClass(/selected/)
  await settleLift()
  await expect.poll(gap).toBeLessThan(1.5)
  await page.getByRole('button', { name: '清除选择', exact: true }).click()
  await expect(node).not.toHaveClass(/selected/)
  await settleLift()
  await expect.poll(gap).toBeLessThan(1.5)
  await node.hover()
  await settleLift()
  await expect.poll(gap).toBeLessThan(1.5)
})
