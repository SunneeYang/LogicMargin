import { sourceExampleURL } from './ui.ts'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'

async function viewport(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.e, y: matrix.f, zoom: matrix.a }
  })
}

async function moveReadingPosition(page: Page) {
  const original = await viewport(page)
  await page.getByRole('button', { name: '放大流程', exact: true }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(original.zoom)
  const canvas = await page.locator('.canvas').boundingBox()
  await page.mouse.move(canvas!.x + 24, canvas!.y + 260)
  await page.mouse.down()
  await page.mouse.move(canvas!.x + 84, canvas!.y + 40, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await viewport(page)).y).toBeLessThan(original.y - 100)
  return viewport(page)
}

test('desktop wheel scrolls both canvas axes without zooming and restores that reading position', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const initial = await viewport(page)
  const node = await page.locator('.react-flow__node[data-id="upgrade-start"]').boundingBox()
  await page.mouse.move(node!.x + node!.width / 2, node!.y + node!.height / 2)
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await viewport(page)).y).toBeLessThan(initial.y - 50)
  expect((await viewport(page)).zoom).toBeCloseTo(initial.zoom, 5)
  const vertical = await viewport(page)
  await page.mouse.wheel(240, 0)
  await expect.poll(async () => (await viewport(page)).x).toBeLessThan(vertical.x - 50)
  const reading = await viewport(page)
  expect(reading.zoom).toBeCloseTo(initial.zoom, 5)
  expect(reading.y).toBeCloseTo(vertical.y, 3)
  await page.locator('.scene-button').filter({ hasText: '启用演示集成' }).click()
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.scene-button').filter({ hasText: '升级订阅套餐' }).click()
  await expect.poll(() => viewport(page)).toEqual(reading)
})

for (const modifier of ['Control', 'Meta']) test(`${modifier} plus wheel zooms while the plain wheel resumes panning`, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const canvas = await page.locator('.canvas').boundingBox()
  await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2)
  const initial = await viewport(page)
  await page.keyboard.down(modifier)
  await page.mouse.wheel(0, -180)
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(initial.zoom)
  await page.keyboard.up(modifier)
  const zoomed = await viewport(page)
  await page.mouse.wheel(0, 200)
  await expect.poll(async () => (await viewport(page)).y).toBeLessThan(zoomed.y - 50)
  expect((await viewport(page)).zoom).toBeCloseTo(zoomed.zoom, 5)
})

test('trackpad pinch still zooms without a physical control key press', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const initial = await viewport(page)
  await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaY: -80, ctrlKey: true, bubbles: true, cancelable: true })
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(initial.zoom)
})

test('scrolling a long comment keeps scrolling inside the editor', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="upgrade-start"]').hover()
  await page.getByRole('button', { name: '讨论：发起套餐升级', exact: true }).click()
  await page.locator('[data-composer]').getByRole('button', { name: '添加新批注', exact: true }).click()
  const input = page.getByRole('dialog', { name: '节点讨论', exact: true }).getByLabel('问题与预期行为')
  await input.fill(Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 条需要核对的说明。`).join('\n'))
  await input.evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 0 })
  const initial = await viewport(page)
  await input.hover()
  await page.mouse.wheel(0, 240)
  await expect.poll(() => input.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect(await viewport(page)).toEqual(initial)
})

test('each scene fits on first visit and restores its own reading position on return', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const upgrade = await moveReadingPosition(page)
  await page.locator('.scene-button').filter({ hasText: '启用演示集成' }).click()
  await expect(page.locator('.scene-title')).toHaveText('启用演示集成')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await info.attach('scene-switch-viewports', {
    body: JSON.stringify({ previousScene: upgrade, nextScene: await viewport(page) }), contentType: 'application/json',
  })
  await page.screenshot({ path: info.outputPath('scene-switch.png') })
  await expect(page.locator('.react-flow__node[data-id="unlock-start"]')).toBeInViewport()
  const unlock = await moveReadingPosition(page)
  await page.locator('.scene-button').filter({ hasText: '升级订阅套餐' }).click()
  await expect(page.locator('.scene-title')).toHaveText('升级订阅套餐')
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(upgrade.zoom, 3)
  await expect.poll(async () => (await viewport(page)).x).toBeCloseTo(upgrade.x, 0)
  await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(upgrade.y, 0)
  await page.locator('.scene-button').filter({ hasText: '启用演示集成' }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(unlock.zoom, 3)
  await expect.poll(async () => (await viewport(page)).x).toBeCloseTo(unlock.x, 0)
  await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(unlock.y, 0)
})

test('a different review with reused scene IDs fits its own graph', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await moveReadingPosition(page)
  const another = structuredClone(sampleReview)
  another.id = 'viewport-isolation-fixture'
  another.title = '独立评审视角测试'
  another.snapshot.fingerprint = 'viewport-isolation-fixture'
  another.nodes.forEach(node => { node.position = { x: node.position.x + 1800, y: node.position.y + 900 } })
  await page.getByLabel('导入评审文件').setInputFiles({
    name: 'viewport-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(another)),
  })
  await expect(page.getByRole('heading', { name: another.title, exact: true })).toBeVisible()
  await expect(page.locator('.react-flow__node[data-id="upgrade-start"]')).toBeInViewport()
})

test('first visit to a wide scene fits both sides of its graph', async ({ page }, info) => {
  await page.goto('/')
  const review = structuredClone(sampleReview)
  review.id = 'wide-viewport-fixture'
  review.title = '宽流程视角测试'
  review.scenes.push({ id: 'wide-viewport', title: '横向分支', description: '首次切入时需要适配整个横向范围。' })
  const left = { ...structuredClone(review.nodes[0]), id: 'wide-left', sceneId: 'wide-viewport', position: { x: 0, y: 0 } }
  const right = { ...structuredClone(review.nodes[1]), id: 'wide-right', sceneId: 'wide-viewport', position: { x: 1800, y: 0 } }
  const branches = Array.from({ length: 7 }, (_, index) => ({ ...structuredClone(right), id: `wide-branch-${index}` }))
  review.nodes.push(left, right, ...branches)
  review.edges.push({ id: 'wide-connection', sceneId: 'wide-viewport', source: left.id, target: right.id, label: '继续', detail: '跨越宽流程的连线。' })
  review.edges.push(...branches.map((node, index) => ({ id: `wide-edge-${index}`, sceneId: 'wide-viewport', source: left.id, target: node.id, label: `分支 ${index + 1}`, detail: '自动拓扑布局后仍有横向宽度的并列分支。' })))
  await page.getByLabel('导入评审文件').setInputFiles({
    name: 'wide-viewport.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)),
  })
  await expect(page.getByRole('heading', { name: review.title, exact: true })).toBeVisible()
  await page.locator('.scene-button').filter({ hasText: '横向分支' }).click()
  await expect(page.locator('.scene-title')).toHaveText('横向分支')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.screenshot({ path: info.outputPath('wide-scene.png') })
  await expect(page.locator('.react-flow__node[data-id="wide-left"]')).toBeInViewport()
  await expect(page.locator('.react-flow__node[data-id="wide-right"]')).toBeInViewport()
  for (const node of branches) await expect(page.locator(`.react-flow__node[data-id="${node.id}"]`)).toBeInViewport({ ratio: 0.99 })
})

test.describe('development public example', () => {
  test.use({ baseURL: sourceExampleURL })
test('fictional review scenes restore their own positions while first visits show the start', async ({ page }) => {
  await page.goto('/?review=task-pipeline')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const enter = await moveReadingPosition(page)
  await page.locator('.scene-button').filter({ hasText: '流水线设置限制' }).click()
  await expect(page.locator('.scene-title')).toHaveText('流水线设置限制')
  await expect(page.locator('.react-flow__node[data-id="loadout-request"]')).toBeInViewport()
  await moveReadingPosition(page)
  await page.locator('.scene-button').filter({ hasText: '提交与模板校验' }).click()
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(enter.zoom, 3)
  await expect.poll(async () => (await viewport(page)).x).toBeCloseTo(enter.x, 0)
  await expect.poll(async () => (await viewport(page)).y).toBeCloseTo(enter.y, 0)
})

})

test('a new standalone revision starts with its own view instead of an old revision camera', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const initial = await viewport(page)
  const reading = await moveReadingPosition(page)
  const next = structuredClone(sampleReview)
  next.title = '新版流程的独立视角'
  next.revision = 'viewport-next-revision'
  next.snapshot.fingerprint = 'viewport-next-fingerprint'
  next.nodes[0].summary += ' 新版补充了流程说明。'
  await page.getByLabel('导入评审文件').setInputFiles({
    name: 'next-revision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)),
  })
  await expect(page.getByRole('heading', { name: next.title, exact: true })).toBeVisible()
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(initial.zoom, 3)
  expect((await viewport(page)).y).toBeGreaterThan(reading.y + 100)
})
