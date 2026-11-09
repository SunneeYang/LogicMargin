import { expect, test } from '@playwright/test'
import { closeSettings, openSettings } from './ui.ts'

for (const view of [
  { width: 320, height: 500, locale: 'zh-CN', theme: 'glass', mode: 'dark' },
  { width: 320, height: 500, locale: 'en', theme: 'soft', mode: 'light' },
  { width: 390, height: 844, locale: 'zh-CN', theme: 'paper', mode: 'dark' },
  { width: 390, height: 844, locale: 'en', theme: 'paper', mode: 'light' },
  { width: 684, height: 320, locale: 'en', theme: 'glass', mode: 'dark' },
  { width: 1440, height: 900, locale: 'zh-CN', theme: 'soft', mode: 'light' },
]) {
  test.describe(`settings ${view.width}x${view.height} ${view.locale}`, () => {
    test.use({ viewport: { width: view.width, height: view.height }, isMobile: view.width <= 900, hasTouch: view.width <= 900 })

    test('centers the modal, contains focus, and keeps all settings reachable', async ({ page }, info) => {
      await page.addInitScript(({ locale, theme, mode }) => {
        localStorage.setItem('logic-margin:language', locale)
        localStorage.setItem('logic-margin:appearance', JSON.stringify({ theme, mode }))
      }, view)
      await page.goto('/')
      await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
      const dialog = await openSettings(page)
      expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true)
      const bounds = (await dialog.boundingBox())!
      expect(Math.abs(bounds.x + bounds.width / 2 - view.width / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(bounds.y + bounds.height / 2 - view.height / 2)).toBeLessThanOrEqual(1)
      expect(bounds.x).toBeGreaterThanOrEqual(4)
      expect(bounds.y).toBeGreaterThanOrEqual(4)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(view.width - 4)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(view.height - 4)
      await expect(dialog.getByRole('tab')).toHaveText(view.locale === 'en' ? ['Interface', 'Keyboard shortcuts', 'Version and updates'] : ['界面', '快捷键', '版本与更新'])
      await expect(dialog.getByLabel(view.locale === 'en' ? 'Code comparison layout' : '代码对照布局', { exact: true })).toHaveValue('split')
      await expect(dialog.locator(`#appearance-mode button[value="${view.mode}"]`)).toHaveAttribute('aria-pressed', 'true')
      await expect(dialog.locator(`#interface-language button[value="${view.locale}"]`)).toHaveAttribute('aria-pressed', 'true')
      for (const selector of ['#interface-theme', '#appearance-mode', '#interface-language', '#code-layout']) {
        const control = dialog.locator(selector)
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport({ ratio: 1 })
      }
      await dialog.locator('#interface-theme').focus()
      await page.keyboard.press('Tab')
      await expect(dialog.locator('#appearance-mode button').first()).toBeFocused()
      for (let step = 0; step < 14; step++) {
        await page.keyboard.press('Tab')
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      }
      await openSettings(page, 'shortcuts')
      const rows = dialog.locator('[data-shortcut-action]')
      await expect(rows).toHaveCount(24)
      await rows.last().scrollIntoViewIfNeeded()
      await expect(rows.last()).toBeInViewport({ ratio: 1 })
      if (view.width === 390 || view.width === 1440) {
        await rows.first().scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath(`shortcuts-${view.locale}-${view.mode}.png`) })
      }
      await openSettings(page, 'version')
      const hint = dialog.locator('.version-settings .appearance-hint').last()
      await hint.scrollIntoViewIfNeeded()
      await expect(hint).toBeInViewport({ ratio: 1 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(view.width)
      if (view.width === 390 || view.width === 1440) await page.screenshot({ path: info.outputPath(`settings-${view.locale}-${view.mode}.png`) })
      await closeSettings(page)
      await expect(dialog).not.toBeVisible()
      await expect(page.locator('.settings-trigger')).toBeFocused()
    })
  })
}

test.describe('appearance preferences', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('mode buttons follow system only when selected and language buttons persist after reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
    await openSettings(page)
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
    await closeSettings(page)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass')
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
    await openSettings(page)
    await expect(page.locator('#interface-language button[value="en"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#appearance-mode button[value="light"]')).toHaveAttribute('aria-pressed', 'true')
  })
})
