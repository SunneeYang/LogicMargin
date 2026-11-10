import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export async function openMenu(page: Page, selector: string) {
  if (selector === '.appearance-menu') return openSettings(page)
  const menu = page.locator(selector)
  const tools = page.locator('.canvas-tools')
  if (selector === '.scope-actions' && await tools.getAttribute('open') === null) await tools.locator(':scope > summary').click()
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click()
  return menu
}

export async function openSettings(page: Page, section: 'interface' | 'shortcuts' | 'version' = 'interface') {
  const dialog = page.locator('.settings-dialog')
  if (!await dialog.isVisible()) await page.locator('.settings-trigger').click()
  const english = await page.locator('html').getAttribute('lang') === 'en'
  const label = {
    interface: english ? 'Interface' : '界面',
    shortcuts: english ? 'Keyboard shortcuts' : '快捷键',
    version: english ? 'Version and updates' : '版本与更新',
  }[section]
  await dialog.getByRole('tab', { name: label, exact: true }).click()
  return dialog
}

export async function closeSettings(page: Page) {
  await page.locator('.settings-dialog').getByRole('button', { name: /^(关闭设置|Close settings)$/ }).click()
}

export async function openInspector(page: Page, tab: 'detail' | 'comments' | 'drafts' | 'changes' = 'comments') {
  const inspector = page.locator('.inspector')
  if (!(await inspector.getAttribute('class'))?.includes('is-open')) {
    await page.getByRole('button', { name: /^评审面板/ }).click()
  }
  const name = { detail: /^详情$/, comments: /^讨论(?:\s|$)/, drafts: /^草稿(?:\s|$)/, changes: /^变化$/ }[tab]
  await inspector.locator('.inspector-tabs').getByRole('button', { name }).click()
  return inspector
}

export async function openTasks(page: Page) {
  const recoveryEntry = page.getByRole('button', { name: '管理评审任务', exact: true })
  if (await recoveryEntry.isVisible()) await recoveryEntry.click()
  else {
    await openMenu(page, '.file-menu')
    await page.getByRole('button', { name: '评审任务', exact: true }).click()
  }
  return page.getByRole('dialog', { name: '评审任务', exact: true })
}

export async function commentScope(page: Page, scope: 'scene' | 'review') {
  const openDiscussion = page.locator('[data-composer][data-state="open"]')
  if (await openDiscussion.isVisible()) await openDiscussion.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await openMenu(page, await page.locator('.scope-actions-inline').count() ? '.canvas-tools' : '.scope-actions')
  await page.getByRole('button', { name: scope === 'scene' ? '批注此场景' : '批注整个评审', exact: true }).click()
}

export async function expectRevision(page: Page, revision: string) {
  const menu = await openMenu(page, '.review-tools')
  await expect(menu.getByText(revision, { exact: true })).toBeVisible()
  await menu.locator(':scope > summary').click()
}

export async function openPipelineReview(page: Page) {
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '打开任务流水线评审', exact: true }).click()
}

export async function exportReview(page: Page) {
  const menu = await openMenu(page, '.file-menu')
  await menu.getByRole('button', { name: '导出评审', exact: true }).click()
}
