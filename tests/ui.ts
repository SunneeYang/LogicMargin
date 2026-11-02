import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export async function openMenu(page: Page, selector: string) {
  const menu = page.locator(selector)
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click()
  return menu
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
  const name = { name: '导出评审', exact: true }
  if (!await page.getByRole('button', name).first().isVisible()) await openMenu(page, '.file-menu')
  await page.getByRole('button', name).filter({ visible: true }).first().click()
}
