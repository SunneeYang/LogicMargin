import { test, expect } from '@playwright/test'
import { commentScope } from './ui.ts'

for (const theme of ['light', 'dark'] as const) {
  test(`system ${theme} theme covers the canvas, controls and inputs`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/')
    await expect(page.locator(`.react-flow.${theme}`)).toBeVisible()
    await commentScope(page, 'scene')
    const appearance = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d')!
      function luminance(color: string) {
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
        const linear = [r, g, b].map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
      }
      function contrast(foreground: string, background: string) {
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
        return (values[0] + 0.05) / (values[1] + 0.05)
      }
      const root = getComputedStyle(document.documentElement)
      const body = getComputedStyle(document.body)
      const input = getComputedStyle(document.querySelector('textarea')!)
      const node = getComputedStyle(document.querySelector('.review-node')!)
      const muted = getComputedStyle(document.querySelector('.node-summary')!)
      const failure = getComputedStyle(document.querySelector('.review-node.kind-failure')!)
      const failureLabel = getComputedStyle(document.querySelector('.kind-failure .node-kind')!)
      const control = getComputedStyle(document.querySelector('.react-flow__controls-button')!)
      const primary = getComputedStyle(document.querySelector('.topbar .button.primary')!)
      const label = getComputedStyle(document.querySelector('.react-flow__edge-text')!)
      const canvas = getComputedStyle(document.querySelector('.react-flow')!)
      const dot = getComputedStyle(document.querySelector('.react-flow__background-pattern.dots')!)
      return {
        scheme: root.colorScheme,
        bodyLight: luminance(body.backgroundColor),
        inputLight: luminance(input.backgroundColor),
        controlLight: luminance(control.backgroundColor),
        dotLight: luminance(dot.fill),
        textContrast: contrast(body.color, body.backgroundColor),
        inputContrast: contrast(input.color, input.backgroundColor),
        nodeContrast: contrast(node.color, node.backgroundColor),
        mutedContrast: contrast(muted.color, node.backgroundColor),
        failureContrast: contrast(failureLabel.color, failure.backgroundColor),
        primaryContrast: contrast(primary.color, primary.backgroundColor),
        edgeLabelContrast: contrast(label.fill, canvas.backgroundColor),
      }
    })
    expect(appearance.scheme).toBe(theme)
    for (const [name, value] of Object.entries(appearance)) {
      if (name.endsWith('Contrast')) expect(value, name).toBeGreaterThanOrEqual(4.5)
    }
    for (const key of ['bodyLight', 'inputLight', 'controlLight'] as const) {
      if (theme === 'dark') expect(appearance[key], key).toBeLessThan(0.1)
      else expect(appearance[key], key).toBeGreaterThan(0.8)
    }
    if (theme === 'dark') expect(appearance.dotLight).toBeLessThan(0.1)
  })
}

test('changing system appearance updates the open review without a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(page.locator('.react-flow.light')).toBeVisible()
  const originalBackground = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)
  await commentScope(page, 'scene')
  await page.getByLabel('问题与预期行为').fill('切换主题后保留草稿')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('.react-flow.dark')).toBeVisible()
  await expect.poll(() => page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(originalBackground)
  await expect(page.getByLabel('问题与预期行为')).toHaveValue('切换主题后保留草稿')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('.react-flow.light')).toBeVisible()
  await expect.poll(() => page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(originalBackground)
})
