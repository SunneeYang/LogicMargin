import { expect, test } from '@playwright/test'

for (const locale of ['zh-CN', 'en'] as const) for (const status of [403, 429]) {
  test(`release denial explains retry without exposing a raw code ${locale} ${status}`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem('logic-margin:language', locale), locale)
    await page.route('**/api/runtime', route => route.fulfill({ json: { version: '1.0.0', local: false, canUpdate: false } }))
    await page.route('**/api/releases/latest', route => route.fulfill({ status: 502, json: { error: `release_http_${status}` } }))
    await page.goto('/')
    await page.locator('.appearance-menu > summary').click()
    const check = page.getByRole('button', { name: locale === 'en' ? 'Check for updates' : '检查新版', exact: true })
    await check.click()
    const error = page.locator('.version-settings [role="alert"]')
    await expect(error).toContainText(locale === 'en' ? 'GitHub is temporarily limiting release checks' : 'GitHub 暂时限制版本检查')
    await expect(error).not.toContainText('release_http_')
    await expect(check).toBeEnabled()
  })
}

test('version status is read only while settings are open', async ({ page }) => {
  let reads = 0
  await page.route('**/api/runtime', route => {
    reads++
    return route.fulfill({ json: { version: '1.0.0', local: false, canUpdate: false } })
  })
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  expect(reads).toBe(0)
  await page.locator('.appearance-menu > summary').click()
  await expect(page.locator('.runtime-version')).toHaveText('1.0.0')
  await page.locator('.appearance-menu > summary').click()
  await expect(page.locator('.version-settings')).toHaveCount(0)
  const closedReads = reads
  await page.waitForTimeout(2300)
  expect(reads).toBe(closedReads)
})

for (const locale of ['zh-CN', 'en'] as const) {
  test(`local updater reports actual restart version ${locale}`, async ({ page }, info) => {
    let runningVersion = '1.0.0'
    let phase = 'idle'
    let checkCount = 0
    const calls: unknown[] = []
    await page.addInitScript(locale => localStorage.setItem('logic-margin:language', locale), locale)
    await page.route('**/api/runtime', route => route.fulfill({ json: { version: runningVersion, local: true, canUpdate: true, csrfToken: 'test-csrf' } }))
    await page.route('**/api/update/status', route => route.fulfill({ json: { phase, version: '1.0.1', reloadRequired: phase === 'completed' } }))
    await page.route('**/api/releases/latest', async route => {
      checkCount++
      await route.fulfill({ json: { version: '1.0.1', newer: true, url: 'https://github.com/SunneeYang/LogicMargin/releases/tag/v1.0.1' } })
    })
    await page.route('**/api/update/start', async route => {
      calls.push(route.request().postDataJSON())
      expect(route.request().headers()['x-logic-margin-csrf']).toBe('test-csrf')
      phase = 'downloading'
      await route.fulfill({ status: 202, json: { phase, version: '1.0.1' } })
    })
    await page.goto('/')
    await page.locator('.appearance-menu > summary').click()
    await expect(page.locator('.runtime-version')).toHaveText('1.0.0')
    expect(checkCount).toBe(0)
    await page.getByRole('button', { name: locale === 'en' ? 'Check for updates' : '检查新版', exact: true }).click()
    const install = page.getByRole('button', { name: locale === 'en' ? 'Update local plugin and service' : '一键更新本机插件与服务', exact: true })
    await install.click()
    expect(calls).toEqual([{ version: '1.0.1' }])
    await expect(page.getByRole('button', { name: locale === 'en' ? 'Cancel update' : '取消更新', exact: true })).toBeVisible()
    // A command reporting completion cannot replace the running backend's version.
    phase = 'completed'
    await expect(page.locator('.runtime-version')).toHaveText('1.0.0')
    await expect(page.locator('.version-status')).not.toContainText(locale === 'en' ? 'Plugin and service updated' : '插件与服务已更新')
    await expect(page.locator('.version-status')).toContainText(locale === 'en' ? 'Verifying running service version' : '正在核实新服务版本')
    runningVersion = '1.0.1'
    await expect(page.locator('.runtime-version')).toHaveText('1.0.1')
    await expect(page.locator('.version-status')).toContainText(locale === 'en' ? 'Plugin and service updated' : '插件与服务已更新')
    await expect(page.locator('.version-settings')).toContainText(locale === 'en' ? 'MCP may need reconnection' : 'MCP 可能需要重连')
    await page.locator('.version-settings').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`update-${locale}.png`) })
  })
}

test('remote update stays disabled and release errors remain retryable', async ({ page }) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { version: '1.0.0', local: false, canUpdate: false } }))
  let fail = true
  await page.route('**/api/releases/latest', route => route.fulfill({ status: fail ? 502 : 200, json: fail ? { error: 'release_unreachable' } : { version: '1.0.1', newer: true, url: 'https://github.com/SunneeYang/LogicMargin/releases/tag/v1.0.1' } }))
  await page.goto('/')
  await page.locator('.appearance-menu > summary').click()
  await expect(page.locator('.runtime-version')).toHaveText('1.0.0')
  const check = page.getByRole('button', { name: '检查新版', exact: true })
  await check.click()
  await expect(page.locator('.version-settings [role="alert"]')).toContainText('无法连接 GitHub')
  await expect(check).toBeEnabled()
  fail = false
  await check.click()
  await expect(page.getByRole('button', { name: '一键更新本机插件与服务', exact: true })).toBeDisabled()
  await expect(page.locator('.version-settings')).toContainText('请在服务本机打开回环地址执行更新')
})

test('manual release check exposes checking and up-to-date states', async ({ page }) => {
  let releaseCheck: () => void = () => {}
  const gate = new Promise<void>(resolve => { releaseCheck = resolve })
  await page.route('**/api/runtime', route => route.fulfill({ json: { version: '1.0.1', local: false, canUpdate: false } }))
  await page.route('**/api/releases/latest', async route => {
    await gate
    await route.fulfill({ json: { version: '1.0.1', newer: false, url: 'https://github.com/SunneeYang/LogicMargin/releases/tag/v1.0.1' } })
  })
  await page.goto('/')
  await page.locator('.appearance-menu > summary').click()
  await page.getByRole('button', { name: '检查新版', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在检查新版…', exact: true })).toBeDisabled()
  releaseCheck()
  await expect(page.locator('.version-status')).toContainText('已是最新稳定版')
  await expect(page.getByRole('button', { name: '一键更新本机插件与服务', exact: true })).toHaveCount(0)
})
