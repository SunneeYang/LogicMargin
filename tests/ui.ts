import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export async function openMenu(page: Page, selector: string) {
  const menu = page.locator(selector)
  const tools = page.locator('.canvas-tools')
  if (selector === '.scope-actions' && await tools.getAttribute('open') === null) await tools.locator(':scope > summary').click()
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click()
  return menu
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
  await openMenu(page, '.scope-actions')
  await page.getByRole('button', { name: scope === 'scene' ? '批注此场景' : '批注整个评审', exact: true }).click()
}

export async function expectRevision(page: Page, revision: string) {
  const menu = await openMenu(page, '.review-tools')
  await expect(menu.getByText(revision, { exact: true })).toBeVisible()
  await menu.locator(':scope > summary').click()
}

export async function openSpiritReview(page: Page) {
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '打开魔灵秘境评审', exact: true }).click()
}

export async function exportReview(page: Page) {
  const menu = await openMenu(page, '.file-menu')
  await menu.getByRole('button', { name: '导出评审', exact: true }).click()
}
