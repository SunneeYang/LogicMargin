import { expect, test } from '@playwright/test'
import { sampleReview } from '../src/sample.ts'

const first = sampleReview.nodes.find(node => node.id === 'upgrade-start')!
const second = sampleReview.nodes.find(node => node.id === 'upgrade-toggle')!
const firstNode = '.react-flow__node[data-id="upgrade-start"]'
const secondNode = '.react-flow__node[data-id="upgrade-toggle"]'

test('the node footer opens the selected step rules, state changes and source evidence', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator(firstNode).locator('.node-footer').click()
  const details = page.locator('.inspector.is-open')
  await expect(details).toBeVisible()
  await expect(page.locator(firstNode)).toHaveClass(/selected/)
  await expect(details.locator('.panel-title')).toHaveText(first.title)
  await expect(details).toContainText(first.detail)
  await expect(details.locator('.state-change')).toContainText(first.input)
  await expect(details.locator('.state-change')).toContainText(first.output)
  const evidence = details.locator('.evidence')
  await evidence.locator('summary').click()
  await expect(evidence).toContainText(first.evidence[0].symbol)
  await expect(evidence).toContainText(`${first.evidence[0].path}:${first.evidence[0].startLine}`)
})

test('the node footer is a keyboard-operable details button', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const footer = page.locator(secondNode).locator('.node-footer')
  await expect(footer).toHaveAttribute('type', 'button')
  await expect(footer).toHaveAccessibleName(`查看步骤与数据：${second.title}`)
  await footer.focus()
  await footer.press('Enter')
  await expect(page.locator('.inspector.is-open .panel-title')).toHaveText(second.title)
  await expect(page.locator(secondNode)).toHaveClass(/selected/)
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await footer.focus()
  await footer.press('Space')
  await expect(page.locator('.inspector.is-open .panel-title')).toHaveText(second.title)
})

test('reading another step keeps the unfinished comment and its original target', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator(firstNode).hover()
  await page.getByRole('button', { name: `批注：${first.title}`, exact: true }).click()
  const editor = page.getByRole('dialog', { name: '流程批注', exact: true })
  const body = '查看其他步骤时保留这条未完成的意见。'
  await editor.getByLabel('问题与预期行为').fill(body)
  await page.locator(secondNode).locator('.node-footer').click({ timeout: 5000 })
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel('问题与预期行为')).toHaveValue(body)
  await expect(editor.locator('.composer-targets')).toHaveText(first.title)
  if ((await editor.getAttribute('class'))?.includes('is-docked')) {
    await editor.getByRole('button', { name: '返回图内编辑', exact: true }).click()
  }
  await expect(page.locator('.inspector.is-open .panel-title')).toHaveText(second.title)
  await editor.getByLabel('问题与预期行为').fill(`${body} 继续编辑。`)
  const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:drafts')!))
  expect(drafts[0]).toMatchObject({ body: `${body} 继续编辑。`, targets: [{ kind: 'node', id: first.id }] })
  await editor.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
  await expect(editor).toHaveClass(/is-docked/)
  await page.locator(firstNode).locator('.node-footer').click()
  await expect(editor).toHaveClass(/is-inline/)
  await expect(editor.getByLabel('问题与预期行为')).toHaveValue(`${body} 继续编辑。`)
  await expect(editor.locator('.composer-targets')).toHaveText(first.title)
  await expect(page.locator('.inspector.is-open .panel-title')).toHaveText(first.title)
})
