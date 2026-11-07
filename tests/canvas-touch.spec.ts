import { devices, expect, test } from '@playwright/test'
import type { CDPSession, Page } from '@playwright/test'

test.use({ ...devices['Pixel 7'] })

type Point = { x: number; y: number }
type Surface = 'blank' | 'node' | 'edge' | 'button'

async function camera(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.e, y: matrix.f, zoom: matrix.a }
  })
}

async function pointOn(page: Page, surface: Surface): Promise<Point> {
  if (surface === 'blank' || surface === 'edge') return page.evaluate(surface => {
    if (surface === 'edge') {
      for (const path of document.querySelectorAll<SVGPathElement>('.react-flow__edge-interaction')) {
        for (let fraction = .1; fraction < 1; fraction += .1) {
          const point = path.getPointAtLength(path.getTotalLength() * fraction).matrixTransform(path.getScreenCTM()!)
          if (point.x > 30 && point.x < innerWidth - 30 && point.y > 100 && point.y < innerHeight - 100
            && document.elementFromPoint(point.x, point.y)?.closest('.react-flow__edge')) return { x: point.x, y: point.y }
        }
      }
    } else {
      const box = document.querySelector('.canvas')!.getBoundingClientRect()
      for (let y = Math.min(innerHeight - 100, box.bottom - 100); y > box.top + 80; y -= 40) {
        for (let x = box.left + 40; x < box.right - 40; x += 40) {
          const element = document.elementFromPoint(x, y)
          if (element?.closest('.react-flow__renderer') && !element.closest('button, .react-flow__node, .react-flow__edge')) return { x, y }
        }
      }
    }
    throw Error(`No touch point on ${surface}`)
  }, surface)
  const selector = surface === 'node' ? '.node-summary' : '.node-comment-button'
  const box = await page.locator(`.react-flow__node[data-id="upgrade-start"] ${selector}`).boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: (Point & { id?: number })[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, id) => ({ ...point, id: point.id ?? id, radiusX: 2, radiusY: 2, force: 1 })) })
}

async function drag(page: Page, cdp: CDPSession, point: Point, cancel = false) {
  await touch(cdp, 'touchStart', [point])
  for (let step = 1; step <= 8; step++) {
    await touch(cdp, 'touchMove', [{ x: point.x - step * 5, y: point.y - step * 8 }])
    await page.waitForTimeout(24)
  }
  await touch(cdp, cancel ? 'touchCancel' : 'touchEnd', [])
}

async function pinch(page: Page, cdp: CDPSession, first: Point, second: Point) {
  await touch(cdp, 'touchStart', [first])
  await page.waitForTimeout(40)
  await touch(cdp, 'touchStart', [first, second])
  for (let step = 1; step <= 8; step++) {
    const factor = 1 + step * .04
    await touch(cdp, 'touchMove', [first, { x: first.x + (second.x - first.x) * factor, y: first.y + (second.y - first.y) * factor }])
    await page.waitForTimeout(24)
  }
  await touch(cdp, 'touchEnd', [])
}

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native touch injection uses Chrome DevTools')
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
})

for (const surface of ['blank', 'node', 'edge', 'button'] as const) {
  test(`one finger pans from ${surface} without selecting or opening a discussion`, async ({ page, context }) => {
    const cdp = await context.newCDPSession(page)
    const before = await camera(page)
    await drag(page, cdp, await pointOn(page, surface))
    await expect.poll(async () => {
      const after = await camera(page)
      return Math.hypot(after.x - before.x, after.y - before.y)
    }).toBeGreaterThan(50)
    expect((await camera(page)).zoom).toBeCloseTo(before.zoom, 3)
    await expect(page.locator('.react-flow__edge.selected, .react-flow__node.selected')).toHaveCount(0)
    await expect(page.locator('[data-composer]')).toHaveCount(0)
  })

  test(`pinch registers a second finger on ${surface}`, async ({ page, context }) => {
    const cdp = await context.newCDPSession(page)
    const first = await pointOn(page, 'node')
    let second = await pointOn(page, surface)
    if (surface === 'node') second = { x: first.x - 90, y: first.y }
    const before = await camera(page)
    await pinch(page, cdp, first, second)
    await expect.poll(async () => (await camera(page)).zoom - before.zoom).toBeGreaterThan(.15)
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1)
    await expect(page.locator('.react-flow__edge.selected, .react-flow__node.selected')).toHaveCount(0)
    await expect(page.locator('[data-composer]')).toHaveCount(0)
  })
}

for (const surface of ['edge', 'button'] as const) {
  test(`pinch can start on ${surface} and leave the canvas ready for another drag`, async ({ page, context }) => {
    const cdp = await context.newCDPSession(page)
    const before = await camera(page)
    await pinch(page, cdp, await pointOn(page, surface), await pointOn(page, 'node'))
    await expect.poll(async () => (await camera(page)).zoom - before.zoom).toBeGreaterThan(.15)
    const zoomed = await camera(page)
    await drag(page, cdp, await pointOn(page, 'blank'))
    await expect.poll(async () => {
      const after = await camera(page)
      return Math.hypot(after.x - zoomed.x, after.y - zoomed.y)
    }).toBeGreaterThan(50)
    expect((await camera(page)).zoom).toBeCloseTo(zoomed.zoom, 3)
    await expect(page.locator('.react-flow__edge.selected, .react-flow__node.selected')).toHaveCount(0)
    await expect(page.locator('[data-composer]')).toHaveCount(0)
  })
}

test('tapping an edge still selects it and tapping a discussion button still opens it', async ({ page }) => {
  const edge = await pointOn(page, 'edge')
  await page.touchscreen.tap(edge.x, edge.y)
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1)
  const button = await pointOn(page, 'button')
  await page.touchscreen.tap(button.x, button.y)
  await expect(page.getByRole('dialog', { name: '节点讨论', exact: true })).toBeVisible()
})

test('lifting the first finger after a pinch lets the remaining finger pan', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  const first = await pointOn(page, 'edge')
  const second = { ...await pointOn(page, 'button'), id: 1 }
  await touch(cdp, 'touchStart', [first])
  await touch(cdp, 'touchStart', [first, second])
  const movedFirst = { x: first.x - 20, y: first.y + 20 }
  await touch(cdp, 'touchMove', [movedFirst, second])
  await touch(cdp, 'touchEnd', [movedFirst])
  const before = await camera(page)
  for (let step = 1; step <= 8; step++) {
    await touch(cdp, 'touchMove', [{ x: second.x - step * 5, y: second.y - step * 8, id: 1 }])
    await page.waitForTimeout(24)
  }
  await touch(cdp, 'touchEnd', [])
  await expect.poll(async () => {
    const after = await camera(page)
    return Math.hypot(after.x - before.x, after.y - before.y)
  }).toBeGreaterThan(50)
  expect((await camera(page)).zoom).toBeCloseTo(before.zoom, 3)
  await expect(page.locator('[data-composer]')).toHaveCount(0)
})

test('a canceled touch gesture does not block the next gesture', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  await drag(page, cdp, await pointOn(page, 'edge'), true)
  const before = await camera(page)
  await drag(page, cdp, await pointOn(page, 'blank'))
  await expect.poll(async () => {
    const after = await camera(page)
    return Math.hypot(after.x - before.x, after.y - before.y)
  }).toBeGreaterThan(50)
})
