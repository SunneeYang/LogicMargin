import { expect, test } from '@playwright/test'

for (const view of [
  { width: 320, height: 500, locale: 'zh-CN', theme: 'glass', mode: 'dark' },
  { width: 320, height: 500, locale: 'en', theme: 'soft', mode: 'light' },
  { width: 390, height: 844, locale: 'zh-CN', theme: 'paper', mode: 'dark' },
  { width: 390, height: 844, locale: 'en', theme: 'paper', mode: 'light' },
  { width: 684, height: 320, locale: 'en', theme: 'glass', mode: 'dark' },
  { width: 1440, height: 900, locale: 'zh-CN', theme: 'soft', mode: 'light' },
]) {
  test.describe(`appearance ${view.width}x${view.height} ${view.locale}`, () => {
    test.use({ viewport: { width: view.width, height: view.height }, isMobile: view.width <= 900, hasTouch: view.width <= 900 })

    test('groups controls evenly and keeps touch text and keyboard focus inside the panel', async ({ page }, info) => {
      await page.addInitScript(({ locale, theme, mode }) => {
        localStorage.setItem('logic-margin:language', locale)
        localStorage.setItem('logic-margin:appearance', JSON.stringify({ theme, mode }))
      }, view)
      await page.goto('/')
      await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
      await page.locator('.appearance-menu > summary').click()
      const panel = page.locator('.appearance-panel')
      await expect(panel).toBeInViewport({ ratio: 1 })
      await expect(panel.locator('.appearance-field')).toHaveCount(3)
      await expect(panel.locator('#appearance-mode')).toHaveAttribute('role', 'group')
      await expect(panel.locator('#interface-language')).toHaveAttribute('role', 'group')
      await expect(panel.locator(`#appearance-mode button[value="${view.mode}"]`)).toHaveAttribute('aria-pressed', 'true')
      await expect(panel.locator(`#interface-language button[value="${view.locale}"]`)).toHaveAttribute('aria-pressed', 'true')

      const metrics = await panel.evaluate(element => {
        const rect = (item: Element) => {
          const box = item.getBoundingClientRect()
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
        }
        return {
          panel: rect(element),
          fields: [...element.querySelectorAll('.appearance-field')].map(field => ({
            ...rect(field),
            label: rect(field.querySelector('.appearance-field-label')!),
            control: rect(field.querySelector('select, [role="group"]')!),
          })),
          controls: [...element.querySelectorAll('select, button')].map(control => {
            const fragments = []
            if (control instanceof HTMLButtonElement) {
              const range = document.createRange()
              range.selectNodeContents(control)
              fragments.push(...[...range.getClientRects()].map(box => ({ x: box.x, y: box.y, right: box.right, bottom: box.bottom })))
            }
            return { ...rect(control), fragments }
          }),
        }
      })
      await info.attach('appearance-panel-geometry', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
      const gaps = metrics.fields.slice(1).map((field, index) => field.y - metrics.fields[index].bottom)
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(12)
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
      for (const field of metrics.fields) {
        expect(field.control.y - field.label.bottom).toBeGreaterThanOrEqual(4)
        expect(field.control.y - field.label.bottom).toBeLessThanOrEqual(12)
      }
      for (const control of metrics.controls) {
        expect(control.width).toBeGreaterThanOrEqual(44)
        expect(control.height).toBeGreaterThanOrEqual(44)
        expect(control.x).toBeGreaterThanOrEqual(metrics.panel.x)
        expect(control.right).toBeLessThanOrEqual(metrics.panel.right)
        for (const fragment of control.fragments) {
          expect(fragment.x).toBeGreaterThanOrEqual(control.x - .5)
          expect(fragment.right).toBeLessThanOrEqual(control.right + .5)
          expect(fragment.y).toBeGreaterThanOrEqual(control.y - .5)
          expect(fragment.bottom).toBeLessThanOrEqual(control.bottom + .5)
        }
      }
      if (view.width === 390) await page.screenshot({ path: info.outputPath(`appearance-panel-${view.locale}-${view.mode}.png`) })
      await panel.locator('#interface-theme').focus()
      await page.keyboard.press('Tab')
      const firstMode = panel.locator('#appearance-mode button').first()
      await expect(firstMode).toBeFocused()
      const focus = await firstMode.evaluate(button => {
        const box = button.getBoundingClientRect(), panel = button.closest('.appearance-panel')!.getBoundingClientRect()
        const style = getComputedStyle(button)
        const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
        return { style: style.outlineStyle, left: box.left - extent, right: box.right + extent, panelLeft: panel.left, panelRight: panel.right }
      })
      expect(focus.style).not.toBe('none')
      expect(focus.left).toBeGreaterThanOrEqual(focus.panelLeft)
      expect(focus.right).toBeLessThanOrEqual(focus.panelRight)
      const lastHint = panel.locator('.appearance-hint').last()
      await lastHint.scrollIntoViewIfNeeded()
      await expect(lastHint).toBeInViewport({ ratio: 1 })
      if (view.height === 320) expect(await panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(view.width)
      await page.keyboard.press('Escape')
      await expect(panel).not.toBeVisible()
    })
  })
}

test.describe('appearance preferences', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('mode buttons follow system only when selected and language buttons persist after reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
    await page.locator('.appearance-menu > summary').tap()
    const mode = page.locator('#appearance-mode')
    await expect(mode.locator('button[value="system"]')).toHaveAttribute('aria-pressed', 'true')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
    await mode.locator('button[value="light"]').tap()
    await expect(mode.locator('button[value="light"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
    await page.locator('#interface-theme').selectOption('glass')
    const language = page.locator('#interface-language')
    await language.locator('button[value="en"]').tap()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await language.locator('button[value="zh-CN"]').focus()
    await page.keyboard.press('Space')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await language.locator('button[value="en"]').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass')
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
    await page.locator('.appearance-menu > summary').tap()
    await expect(page.locator('#interface-language button[value="en"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#appearance-mode button[value="light"]')).toHaveAttribute('aria-pressed', 'true')
  })
})
