import { expect, test } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'

for (const colorScheme of ['light', 'dark'] as const) {
  test(`legend and directional focus explain the flow in ${colorScheme} mode`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await page.locator('.canvas-legend > summary').click()
    const legend = page.getByLabel('流程图图例', { exact: true })
    await expect(legend).toBeVisible()
    await expect(legend).toContainText('执行一个步骤')
    await expect(legend).toContainText('按条件选择分支')
    await expect(legend).toContainText('正常完成或产出')
    await expect(legend).toContainText('拒绝、中断或异常')
    await expect(legend).toContainText('统一实线边框')
    await expect(legend).toContainText('图标和文字')
    await expect(legend).toContainText('强调色外框表示选中')
    await expect(legend).toContainText('留白交叉表示跨过、不连接')
    await expect(legend).toContainText('不代表节点已通过评审')
    await page.locator('.canvas-legend > summary').click()
    const neutral = await page.locator('.review-node.kind-action').first().evaluate(element => {
      const style = getComputedStyle(element)
      return { border: style.borderTopColor, background: style.backgroundColor }
    })
    for (const kind of ['action', 'decision', 'result', 'failure']) {
      const node = page.locator(`.review-node.kind-${kind}`).first()
      await expect(node).toHaveCSS('border-top-style', 'solid')
      await expect(node).toHaveCSS('border-top-color', neutral.border)
      await expect(node).toHaveCSS('background-color', neutral.background)
      await expect(node.locator('.node-kind svg')).toHaveCount(1)
    }
    const decision = page.locator('.react-flow__node[data-id="upgrade-toggle"]')
    await expect(decision.locator('.node-kind')).toHaveText('判断')
    await expect(decision.locator('.node-kind .lucide-diamond')).toHaveCount(1)
    await decision.locator('.node-title').click()
    await expect(decision.locator('.review-node')).toHaveCSS('border-top-style', 'solid')
    await expect(decision.locator('.review-node')).not.toHaveCSS('border-top-color', neutral.border)
    const incoming = page.locator('.react-flow__edge[data-id="upgrade-start-to-toggle"]')
    const outgoing = page.locator('.react-flow__edge[data-id="upgrade-toggle-to-level"]')
    await expect(incoming).toHaveClass(/flow-incoming/)
    await expect(outgoing).toHaveClass(/flow-outgoing/)
    await expect(incoming.locator('.edge-flow-light')).toHaveCSS('animation-name', 'edge-flow')
    await expect(outgoing.locator('.edge-flow-light')).toHaveCSS('animation-name', 'edge-flow')
    const curvedPath = await outgoing.locator('.react-flow__edge-path').getAttribute('d')
    expect(curvedPath).toContain('Q')
    for (const layer of ['.edge-crossing-gap', '.react-flow__edge-interaction', '.edge-flow-light']) {
      await expect(outgoing.locator(layer)).toHaveAttribute('d', curvedPath!)
    }
    await expect(outgoing.locator('.react-flow__edge-path')).toHaveAttribute('marker-end', /url\(/)
    const appearance = page.getByRole('group', { name: '节点显示方式', exact: true })
    await appearance.getByRole('button', { name: '多样式', exact: true }).click()
    await expect(outgoing.locator('.react-flow__edge-path')).toHaveAttribute('d', curvedPath!)
    await appearance.getByRole('button', { name: '简洁', exact: true }).click()
    await expect(outgoing.locator('.react-flow__edge-path')).toHaveAttribute('d', curvedPath!)
    const incomingStroke = await incoming.locator('.react-flow__edge-path').evaluate(element => getComputedStyle(element).stroke)
    expect(await outgoing.locator('.react-flow__edge-path').evaluate(element => getComputedStyle(element).stroke)).toBe(incomingStroke)
    expect(await page.locator('.react-flow__edge.is-unrelated').count()).toBeGreaterThan(0)
    const otherCondition = page.locator('.react-flow__edge.is-unrelated').first()
    await expect(otherCondition).toHaveCSS('opacity', '1')
    await expect(otherCondition.locator('.react-flow__edge-text')).toHaveCSS('opacity', '1')
    const light = incoming.locator('.edge-flow-light')
    const offset = await light.evaluate(element => getComputedStyle(element).strokeDashoffset)
    await expect.poll(() => light.evaluate(element => getComputedStyle(element).strokeDashoffset)).not.toBe(offset)
    await page.getByRole('button', { name: '定位当前选择', exact: true }).click()
    await page.screenshot({ path: info.outputPath(`flow-focus-${colorScheme}.png`) })
    await page.locator('.canvas-legend > summary').click()
    await page.screenshot({ path: info.outputPath(`flow-legend-${colorScheme}.png`) })
    await page.locator('.canvas-legend > summary').click()
    await page.getByRole('button', { name: '清除选择', exact: true }).click()
    await expect(page.locator('.edge-flow-light')).toHaveCount(0)
    await expect(page.locator('.react-flow__edge.is-unrelated')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('desktop overview can restore readable text around the selected step', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const selected = page.locator('.react-flow__node[data-id="upgrade-toggle"]')
  await selected.locator('.node-title').click()
  await page.getByRole('button', { name: '显示完整流程', exact: true }).click()
  const zoom = () => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)
  await expect.poll(zoom).toBeLessThan(1)
  await page.getByRole('button', { name: '恢复阅读视图', exact: true }).click()
  await expect.poll(zoom).toBe(1)
  await expect(selected).toBeInViewport({ ratio: 1 })
  await expect(selected).toHaveClass(/selected/)
})

test('parallel transitions keep separate routes and precise comment targets', async ({ page }) => {
  await page.goto('/')
  const review = structuredClone(sampleReview)
  review.id = 'parallel-route-fixture'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.filter(node => node.sceneId === review.scenes[0].id).slice(0, 2)
  review.nodes.forEach(node => { node.position = { x: 0, y: 0 } })
  const original = review.edges.find(edge => edge.source === review.nodes[0].id && edge.target === review.nodes[1].id)!
  review.edges = [original, { ...original, id: 'parallel-resume', label: '恢复进入' }]
  await page.getByLabel('导入评审文件').setInputFiles({ name: 'parallel.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(review)) })
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const one = page.locator(`.react-flow__edge[data-id="${original.id}"]`)
  const two = page.locator('.react-flow__edge[data-id="parallel-resume"]')
  await expect(one.locator('.edge-crossing-gap')).toHaveCount(1)
  const path = await one.locator('.react-flow__edge-path').getAttribute('d')
  expect(await two.locator('.react-flow__edge-path').getAttribute('d')).not.toBe(path)
  const first = await page.locator(`.react-flow__node[data-id="${review.nodes[0].id}"]`).boundingBox()
  const second = await page.locator(`.react-flow__node[data-id="${review.nodes[1].id}"]`).boundingBox()
  expect(second!.y).toBeGreaterThan(first!.y + first!.height)
  const curvePoint = await two.locator('.react-flow__edge-path').evaluate(element => {
    if (!(element instanceof SVGPathElement)) throw new Error('Expected an SVG edge path')
    let start = { x: 0, y: 0 }
    for (const command of element.getAttribute('d')!.match(/[MLQ][^MLQ]*/g)!) {
      const values = command.slice(1).trim().split(/[,\s]+/).map(Number)
      if (command[0] === 'Q') {
        const [cx, cy, x, y] = values
        const midpoint = new DOMPoint((start.x + 2 * cx + x) / 4, (start.y + 2 * cy + y) / 4)
        const screen = midpoint.matrixTransform(element.getScreenCTM()!)
        return { x: screen.x, y: screen.y }
      }
      start = { x: values[0], y: values[1] }
    }
    throw new Error('Expected a curved section on the parallel edge')
  })
  await page.mouse.click(curvePoint.x, curvePoint.y, { button: 'right' })
  const editor = page.getByRole('dialog', { name: '流程批注', exact: true })
  await expect(editor.locator('.composer-targets')).toHaveText('连线 · 恢复进入')
  await editor.getByLabel('问题与预期行为').fill('核对恢复进入路径。')
  await editor.getByRole('button', { name: '添加批注', exact: true }).click()
  const saved = await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!), review.id)
  expect(saved.comments[0].targets).toEqual([{ kind: 'edge', id: 'parallel-resume' }])
})

test('reduced motion keeps direction highlights without moving light', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="upgrade-toggle"] .node-title').click()
  await expect(page.locator('.edge-flow-light').first()).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.flow-focus-guide')).toHaveCount(0)
  await page.locator('.canvas-legend > summary').click()
  const legend = page.getByLabel('流程图图例', { exact: true })
  await expect(legend).toContainText('前序 →')
  await expect(legend).toContainText('→ 后续')
})

for (const width of [320, 390]) {
  test(`the legend remains reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/')
    await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
    await page.locator('.react-flow__node[data-id="upgrade-start"] .node-title').click()
    const settings = page.getByText('显示设置', { exact: true })
    if (await settings.isVisible()) await settings.click()
    await page.locator('.canvas-legend > summary').click()
    const panel = page.getByLabel('流程图图例', { exact: true })
    await expect(page.locator('.canvas-display-options')).toBeInViewport({ ratio: 1 })
    const bounds = await panel.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    const lastParagraph = panel.locator(':scope > p').last()
    await lastParagraph.scrollIntoViewIfNeeded()
    await expect(lastParagraph).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.locator('.canvas-legend > summary').focus()
    await page.keyboard.press('Escape')
    await expect(panel).not.toBeVisible()
  })
}
