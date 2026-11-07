import { expect, test } from '@playwright/test'

for (const device of [
  { width: 320, height: 844, theme: 'glass', mode: 'dark' },
  { width: 390, height: 844, theme: 'paper', mode: 'light' },
  { width: 684, height: 584, theme: 'soft', mode: 'dark' },
]) {
  test.describe(`display settings at ${device.width}px`, () => {
    test.use({ viewport: { width: device.width, height: device.height }, isMobile: true, hasTouch: true, locale: 'zh-CN' })

    for (const locale of ['zh-CN', 'en']) test(`${locale} keeps language reachable and display choices in one touch row`, async ({ page }, info) => {
      await page.addInitScript(({ theme, mode }) => {
        localStorage.setItem('logic-margin:appearance', JSON.stringify({ theme, mode }))
        localStorage.setItem('logic-margin:language', 'zh-CN')
      }, { theme: device.theme, mode: locale === 'zh-CN' ? 'dark' : device.mode })
      await page.goto('/')
      await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')

      const appearance = page.locator('.appearance-menu > summary')
      await appearance.tap()
      const language = page.locator('#interface-language')
      await expect(language).toBeInViewport({ ratio: 1 })
      const languageBounds = (await language.boundingBox())!
      expect(languageBounds.height).toBeGreaterThanOrEqual(44)
      await language.locator(`button[value="${locale}"]`).tap()
      await expect(language.locator(`button[value="${locale}"]`)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await appearance.tap()

      const toggle = page.locator('.display-settings-toggle')
      await toggle.tap()
      const options = page.locator('.canvas-display-options')
      const choices = options.locator('.node-appearance-switch button')
      const legendToggle = options.locator('.canvas-legend > summary')
      await expect(options).toBeInViewport({ ratio: 1 })
      const geometry = await options.evaluate(panel => {
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect()
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
        }
        return {
          panel: rect(panel),
          controls: [...panel.querySelectorAll('.node-appearance-switch button, .canvas-legend > summary')].map(control => {
            const fragments = [...control.querySelectorAll('svg')].map(rect)
            const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT)
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (!text.textContent?.trim()) continue
              const range = document.createRange()
              range.selectNodeContents(text)
              fragments.push(...[...range.getClientRects()].map(box => ({ x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height })))
            }
            return { ...rect(control), fragments }
          }),
        }
      })
      await info.attach('display-control-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
      expect(geometry.panel.width).toBeLessThanOrEqual(288)
      expect(geometry.panel.height).toBeLessThanOrEqual(84)
      expect(geometry.controls).toHaveLength(3)
      for (const control of geometry.controls) {
        expect(control.width).toBeGreaterThanOrEqual(44)
        expect(control.height).toBeGreaterThanOrEqual(44)
        expect(Math.abs(control.y + control.height / 2 - (geometry.controls[0].y + geometry.controls[0].height / 2))).toBeLessThan(1)
        for (const fragment of control.fragments) {
          expect(fragment.x).toBeGreaterThanOrEqual(control.x - .5)
          expect(fragment.right).toBeLessThanOrEqual(control.right + .5)
          expect(fragment.y).toBeGreaterThanOrEqual(control.y - .5)
          expect(fragment.bottom).toBeLessThanOrEqual(control.bottom + .5)
        }
      }
      expect(geometry.controls[0].right).toBeLessThanOrEqual(geometry.controls[1].x)
      expect(geometry.controls[1].right).toBeLessThan(geometry.controls[2].x)
      await page.screenshot({ path: info.outputPath(`display-settings-${locale}.png`) })

      await choices.nth(1).tap()
      await expect(page.locator('.canvas')).toHaveAttribute('data-node-appearance', 'distinct')
      await legendToggle.tap()
      const legend = options.locator('.canvas-legend-panel')
      await expect(legend).toBeVisible()
      await expect(options).toBeInViewport({ ratio: 1 })
      const expanded = await options.evaluate(panel => ({
        width: panel.clientWidth - parseFloat(getComputedStyle(panel).paddingLeft) - parseFloat(getComputedStyle(panel).paddingRight),
        legendWidth: panel.querySelector('.canvas-legend-panel')!.getBoundingClientRect().width,
        scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
      }))
      expect(expanded.legendWidth).toBeCloseTo(expanded.width, 0)
      expect(expanded.scrollHeight).toBeGreaterThan(expanded.clientHeight)
      await legend.locator(':scope > p').last().scrollIntoViewIfNeeded()
      await expect(legend.locator(':scope > p').last()).toBeInViewport({ ratio: 1 })
      expect(await options.evaluate(panel => panel.scrollTop)).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(device.width)
      if (device.width === 320 && locale === 'en') await page.screenshot({ path: info.outputPath('display-settings-legend-expanded.png') })
      await legendToggle.focus()
      await page.keyboard.press('Escape')
      await expect(legend).not.toBeVisible()
      await expect(options).toBeVisible()
      await toggle.focus()
      await page.keyboard.press('Escape')
      await expect(options).not.toBeVisible()
      await expect(toggle).toBeFocused()
    })
  })
}
