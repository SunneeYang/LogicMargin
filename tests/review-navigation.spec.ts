import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { addComment, setCommentStatus } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession } from '../src/session-types.ts'
import type { ReviewDocument } from '../src/types.ts'
import { closeSettings, openInspector, openSettings } from './ui.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const previousName = '上一条评审意见'
const nextName = '下一条评审意见'
const surface = (page: Page) => page.locator('[data-composer][data-state="open"]')
const opinionId = (number: number) => `navigation-opinion-${number}`
const item = (window: Locator, number: number) => window.locator(`#discussion-thread-${opinionId(number)}`)
const navigation = (window: Locator) => window.getByRole('navigation', { name: '评审意见导航', exact: true })

function fixture() {
  const before: ReviewDocument = structuredClone(sampleReview)
  before.id = 'review-navigation-fixture'
  before.title = '逐条复核导航验收'
  before.revision = 'navigation-v1'
  before.comments = []
  before.scenes = [
    { id: 'navigation-main', title: '规则检查', description: '虚构示例：检查服务和资源条件。' },
    { id: 'navigation-recovery', title: '异常恢复', description: '虚构示例：失败时保留原状态。' },
  ]
  before.nodes = before.nodes.slice(0, 3).map((node, index) => ({ ...node,
    id: ['navigation-a', 'navigation-b', 'navigation-other'][index],
    sceneId: index < 2 ? 'navigation-main' : 'navigation-recovery',
    title: ['检查服务开关', '校验资源条件', '恢复原有状态'][index],
    detail: ['服务关闭时拒绝升级。', '校验通过后才能扣除资源。', '写入失败时恢复已扣除的资源。'][index],
    position: { x: 0, y: index * 220 }, evidence: [],
  }))
  before.edges = [{ id: 'navigation-edge', sceneId: 'navigation-main', source: 'navigation-a', target: 'navigation-b', label: '服务可用', detail: '继续校验资源条件。' }]
  const setSources = (review: ReviewDocument, value: boolean) => {
    review.nodes.forEach((node, index) => {
      const code = `function rule${index}() { return ${value}; }`
      node.evidence = [{ path: `demo/rule-${index}.ts`, symbol: `rule${index}`, startLine: 1, endLine: 1, code, digest: hash(code) }]
    })
    const files = review.nodes.map(node => ({ path: node.evidence[0].path, sha256: hash(`${node.evidence[0].code}\n`) }))
    review.snapshot = { ...review.snapshot, commit: `fixture-${review.revision}`, files, fingerprint: hash(JSON.stringify(files)) }
  }
  setSources(before, false)
  let review = structuredClone(before)
  review.revision = 'navigation-v2'
  setSources(review, true)
  review.baseline = before
  for (const [index, nodeId] of ['navigation-a', 'navigation-a', 'navigation-b', 'navigation-other'].entries()) {
    review = addComment(review, [{ kind: 'node', id: nodeId }], `第 ${index + 1} 条待核对意见`)
    Object.assign(review.comments.at(-1)!, { id: opinionId(index + 1), createdAt: `2026-11-11T00:00:0${index}Z` })
  }
  review.comments.reverse()
  return review
}

async function openFixture(page: Page, language = 'zh-CN', review = fixture()) {
  await page.addInitScript(({ review, language }) => {
    if (localStorage.getItem('logic-margin:active') !== review.id) {
      localStorage.setItem('logic-margin:active', review.id)
      localStorage.setItem(`logic-margin:review:${review.id}`, JSON.stringify(review))
    }
    localStorage.setItem('logic-margin:language', language)
  }, { review, language })
  await page.goto('/')
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  return review
}

async function expandFromList(page: Page, number: number) {
  const panel = await openInspector(page, 'comments')
  await panel.locator('.comment-filter').getByRole('button', { name: /^全部 / }).click()
  await panel.locator(`#thread-${opinionId(number)} .read-discussion`).click()
  const window = surface(page)
  await expect(navigation(window)).toBeVisible()
  return window
}

async function expectPosition(window: Locator, position: number) {
  await expect(navigation(window)).toContainText(`${position} / 4`)
  await expect(item(window, position)).toHaveClass(/is-active/)
}

async function settleWindow(window: Locator) {
  await window.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})))
  })
  await expect(window).toHaveCSS('transform', 'none')
}

async function localComments(page: Page, id: string) {
  return page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!).comments, id)
}

test('pure navigation follows chronological entries across nodes and scenes without changing state', async ({ page }, info) => {
  const review = await openFixture(page)
  const firstNode = page.locator('.react-flow__node[data-id="navigation-a"]')
  await firstNode.locator('.node-title').click()
  await expect(firstNode).toHaveClass(/selected/)
  await expect(page.locator('.selection-count')).toHaveText('已选 1 项')
  await firstNode.focus()
  await page.keyboard.press('i')
  await expect(surface(page)).toBeVisible()
  await expect(navigation(surface(page))).toHaveCount(0)
  const panel = await openInspector(page, 'comments')
  await expect(panel.locator('.inspector-body').getByRole('button', { name: previousName, exact: true })).toHaveCount(0)
  await expect(panel.locator('.inspector-body').getByRole('button', { name: nextName, exact: true })).toHaveCount(0)
  await expect(panel.locator('.comment-body')).toHaveText([1, 2, 3, 4].map(number => `第 ${number} 条待核对意见`))
  await panel.locator(`#thread-${opinionId(2)} .read-discussion`).click()
  const window = surface(page), nav = navigation(window)
  await expectPosition(window, 2)
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await expectPosition(window, 1)
  await expect(nav.getByRole('button', { name: previousName, exact: true })).toBeDisabled()
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 2)
  await expect(window.locator('.discussion-target')).toHaveText('检查服务开关')
  await settleWindow(window)
  const anchored = await nav.boundingBox()
  await page.screenshot({ path: info.outputPath('desktop-reading-navigation.png') })
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 3)
  await expect(window.locator('.discussion-target')).toHaveText('校验资源条件')
  await settleWindow(window)
  await expect.poll(async () => {
    const box = await nav.boundingBox()
    return Math.max(Math.abs(box!.x - anchored!.x), Math.abs(box!.y - anchored!.y))
  }).toBeLessThanOrEqual(1)
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 4)
  await expect(page.locator('.scene-button.active')).toContainText('异常恢复')
  await expect(window.locator('.discussion-target')).toHaveText('恢复原有状态')
  await settleWindow(window)
  await expect.poll(async () => {
    const box = await nav.boundingBox()
    return Math.max(Math.abs(box!.x - anchored!.x), Math.abs(box!.y - anchored!.y))
  }).toBeLessThanOrEqual(1)
  await expect(nav.getByRole('button', { name: nextName, exact: true })).toBeDisabled()
  await nav.getByRole('button', { name: previousName, exact: true }).focus()
  await page.keyboard.press('[')
  await expectPosition(window, 3)
  await page.keyboard.press(']')
  await expectPosition(window, 4)
  expect(await localComments(page, review.id)).toEqual(review.comments)
})

test('navigation preserves reply drafts, the current code tab, code layout and docking', async ({ page }) => {
  const review = await openFixture(page)
  const window = await expandFromList(page, 2), nav = navigation(window)
  await item(window, 2).getByRole('button', { name: '回复讨论', exact: true }).click()
  const input = window.getByLabel('补充说明', { exact: true })
  await input.fill('返回这条意见后继续补充。')
  await input.press(']')
  await expect(input).toHaveValue('返回这条意见后继续补充。]')
  await expectPosition(window, 2)
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 3)
  await expect(window.getByLabel('补充说明', { exact: true })).toHaveCount(0)
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await expectPosition(window, 2)
  await expect(input).toHaveValue('返回这条意见后继续补充。]')
  await window.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await expect(window.locator('.cm-editor')).toHaveCount(2)
  await window.getByRole('button', { name: '统一', exact: true }).click()
  await window.locator('.cm-content').first().focus()
  await expect(window.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false')
  await page.keyboard.press(']')
  await expectPosition(window, 3)
  await expect(window.getByRole('tab', { name: '代码 diff', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(window.locator('.cm-editor')).toHaveCount(1)
  await window.locator('.cm-content').first().focus()
  await page.keyboard.press('[')
  await expectPosition(window, 2)
  await window.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
  for (const position of [3, 4]) {
    await nav.getByRole('button', { name: nextName, exact: true }).click()
    await expectPosition(window, position)
    await expect(window).toHaveClass(/is-docked/)
    await expect(window.getByRole('tab', { name: '代码 diff', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByRole('button', { name: '统一', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(window.locator('.cm-editor')).toHaveCount(1)
  }
  await expect(page.locator('.scene-button.active')).toContainText('异常恢复')
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await expectPosition(window, 2)
  await window.getByRole('tab', { name: '详情与讨论', exact: true }).click()
  await expect(input).toHaveValue('返回这条意见后继续补充。]')
  const settings = await openSettings(page, 'shortcuts')
  await settings.locator('[data-shortcut-action="nextReviewItem"] .shortcut-binding').click()
  await page.keyboard.press('Shift+J')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('logic-margin:shortcuts')!).nextReviewItem)).toBe('Shift+J')
  await closeSettings(page)
  await expect(nav.getByRole('button', { name: nextName, exact: true })).toHaveAttribute('title', /J/)
  await nav.getByRole('button', { name: nextName, exact: true }).focus()
  await page.keyboard.press(']')
  await expectPosition(window, 2)
  await page.keyboard.press('Shift+J')
  await expectPosition(window, 3)
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await expectPosition(window, 2)
  await expect(input).toHaveValue('返回这条意见后继续补充。]')
  expect(await localComments(page, review.id)).toEqual(review.comments)
})

async function createSession(request: APIRequestContext) {
  const response = await request.post('/api/review-sessions', { data: { review: fixture() } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const state = await response.json() as ReviewSession
  const path = `/api/review-sessions/${state.id}`
  const get = async () => await (await request.get(path)).json() as ReviewSession
  return { state, path, get }
}

test('unsaved discussion edits survive node, scene, panel and close actions until explicitly saved or canceled', async ({ page }) => {
  const review = await openFixture(page)
  const panel = await openInspector(page, 'comments')
  const card = panel.locator(`#thread-${opinionId(1)}`)
  await card.getByRole('button', { name: '编辑讨论内容', exact: true }).click()
  const listForm = card.getByRole('form', { name: '编辑讨论内容', exact: true })
  await listForm.getByRole('textbox').fill('列表中的修改尚未保存。')
  await panel.locator('.comment-filter').getByRole('button', { name: /^已确认解决 / }).click()
  await expect(panel.locator('.comment-filter').getByRole('button', { name: /^全部 / })).toHaveAttribute('aria-pressed', 'true')
  await card.getByRole('button', { name: '确认解决', exact: true }).click()
  await expect(card).toHaveClass(/status-open/)
  await expect(listForm.getByRole('textbox')).toHaveValue('列表中的修改尚未保存。')
  await listForm.getByRole('button', { name: '取消', exact: true }).click()

  const window = await expandFromList(page, 1)
  await item(window, 1).getByRole('button', { name: '编辑讨论内容', exact: true }).click()
  const form = item(window, 1).getByRole('form', { name: '编辑讨论内容', exact: true })
  await form.getByRole('textbox').fill('阅读窗口中的修改尚未保存。')
  for (const action of [
    () => page.locator('.react-flow__node[data-id="navigation-b"] .node-title').click(),
    () => page.locator('.scene-button').filter({ hasText: '异常恢复' }).click(),
    () => window.getByRole('button', { name: '关闭讨论', exact: true }).click(),
    () => panel.locator('.inspector-tabs').getByRole('button', { name: '详情', exact: true }).click(),
  ]) {
    await action()
    await expect(form.getByRole('textbox')).toHaveValue('阅读窗口中的修改尚未保存。')
    await expect(form).toBeVisible()
    await expect(page.locator('.scene-button.active')).toContainText('规则检查')
    await expectPosition(window, 1)
  }
  await window.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await window.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await expect(window.getByRole('tab', { name: '详情与讨论', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(form.getByRole('textbox')).toHaveValue('阅读窗口中的修改尚未保存。')
  await window.getByRole('button', { name: '移到侧栏编辑', exact: true }).click()
  await expect(window).toHaveClass(/is-docked/)
  await expect(form.getByRole('textbox')).toHaveValue('阅读窗口中的修改尚未保存。')
  expect(await localComments(page, review.id)).toEqual(review.comments)
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await page.locator('.scene-button').filter({ hasText: '异常恢复' }).click()
  await expect(page.locator('.scene-button.active')).toContainText('异常恢复')
  await expect(form).toHaveCount(0)
})

test('confirmed entries remain navigable, unsaved edits are protected and a new round clears the old sequence', async ({ page, request }) => {
  const { state: initial, path, get } = await createSession(request)
  await page.goto(`/?session=${initial.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  const panel = await openInspector(page, 'comments')
  await panel.getByRole('button', { name: '开始逐条复核', exact: true }).click()
  const window = surface(page), nav = navigation(window)
  await expectPosition(window, 1)
  await item(window, 1).getByRole('button', { name: '确认并看下一条', exact: true }).click()
  await expectPosition(window, 2)
  await expect.poll(async () => (await get()).review.comments.find(comment => comment.id === opinionId(1))?.status).toBe('resolved')
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await expectPosition(window, 1)
  await expect(item(window, 1)).toHaveClass(/status-resolved/)
  await expect(item(window, 1).getByRole('button', { name: '重新打开', exact: true })).toBeVisible()
  await item(window, 1).getByRole('button', { name: '编辑讨论内容', exact: true }).click()
  const form = item(window, 1).getByRole('form', { name: '编辑讨论内容', exact: true })
  await form.getByRole('textbox', { name: '编辑讨论内容', exact: true }).fill('尚未保存的正文修改，不应丢失。')
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 1)
  await expect(form.getByRole('textbox')).toHaveValue('尚未保存的正文修改，不应丢失。')
  await expect(page.locator('.notice').filter({ hasText: /保存.*取消|取消.*保存/ })).toBeVisible()
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 2)
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`logic-margin:session:${id}:pending`), initial.id)).toBeNull()
  const current = await get()
  const next = structuredClone(current.review)
  next.revision = 'navigation-v3'
  next.comments = []
  const revised = await request.post(`${path}/revise`, { data: { expectedVersion: current.version, review: next,
    publication: { baseRound: current.round, summary: '进入新的复核轮次', unchangedReason: '复用未变规则，检验旧导航序列清理',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files: next.snapshot.files, fingerprint: next.snapshot.fingerprint } } } })
  expect(revised.ok(), await revised.text()).toBeTruthy()
  await expect(surface(page)).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '评审意见导航', exact: true })).toHaveCount(0)
  expect((await get()).round).toBe(2)
})

for (const language of ['zh-CN', 'en'] as const) test(`phone ${language} keeps navigation above both tabs with accessible touch targets`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFixture(page, language)
  let panel: Locator
  if (language === 'zh-CN') panel = await openInspector(page, 'comments')
  else {
    await page.locator('.panel-toggle').click()
    panel = page.locator('.inspector')
    await panel.locator('.inspector-tabs').getByRole('button', { name: /^Discussion(?:\s|$)/ }).click()
  }
  await expect(panel.locator('.inspector-body').getByRole('navigation')).toHaveCount(0)
  await panel.locator(`#thread-${opinionId(1)} .read-discussion`).click()
  const window = surface(page), nav = window.getByRole('navigation')
  const buttons = nav.getByRole('button')
  await expect(nav).toContainText('1 / 4')
  await settleWindow(window)
  for (const button of await buttons.all()) {
    const box = await button.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    await expect(button).toHaveAttribute('aria-label', /.+/)
    if (language === 'en') expect(await button.getAttribute('aria-label')).not.toMatch(/\p{Script=Han}/u)
  }
  expect(await nav.evaluate(element => element.getBoundingClientRect().bottom <= element.closest('[data-composer]')!.querySelector('.inspection-tabs')!.getBoundingClientRect().top + 1)).toBe(true)
  await buttons.last().click()
  await expect(nav).toContainText('2 / 4')
  await window.getByRole('tab', { name: language === 'en' ? 'Code diff' : '代码 diff', exact: true }).click()
  await buttons.last().click()
  await expect(nav).toContainText('3 / 4')
  await expect(window.getByRole('tab', { name: language === 'en' ? 'Code diff' : '代码 diff', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: info.outputPath(`phone-review-navigation-${language}.png`) })
  await page.setViewportSize({ width: 320, height: 500 })
  await expect(nav).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  const bounds = await nav.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
})

for (const { width, language } of [{ width: 1440, language: 'zh-CN' }, { width: 320, language: 'en' }] as const) {
  test(`canvas entry and Shift+R open the first unresolved opinion without the list at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 1000 })
    const review = setCommentStatus(fixture(), opinionId(1), 'resolved')
    review.scenes.reverse()
    await openFixture(page, language, review)
    await expect(page.locator('.scene-button.active')).toContainText('异常恢复')
    await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
    const entry = page.locator('.review-start')
    await expect(entry).toBeInViewport({ ratio: 1 })
    await expect(entry).toHaveAttribute('aria-label', /.+/)
    if (language === 'zh-CN') await expect(entry).toHaveAttribute('aria-label', /开始复核.*3/)
    else expect(await entry.getAttribute('aria-label')).not.toMatch(/\p{Script=Han}/u)
    expect(await localComments(page, review.id)).toEqual(review.comments)
    await entry.click()
    const window = surface(page), nav = window.getByRole('navigation')
    await expect(nav).toContainText('1 / 3')
    await expect(item(window, 2)).toHaveClass(/is-active/)
    await expect(item(window, 2)).toHaveClass(/status-open/)
    await expect(window.locator('.discussion-target')).toHaveText('检查服务开关')
    await expect(window.getByRole('tab', { name: language === 'en' ? 'Details and discussion' : '详情与讨论', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.scene-button.active')).toContainText('规则检查')
    await expect(page.locator('.react-flow__node[data-id="navigation-a"]')).toHaveClass(/selected/)
    expect(await localComments(page, review.id)).toEqual(review.comments)
    await settleWindow(window)
    await expect(nav).toBeInViewport({ ratio: 1 })
    if (width === 320) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await page.screenshot({ path: info.outputPath(`canvas-review-entry-${width}.png`) })
    await window.getByRole('button', { name: language === 'en' ? 'Close discussion' : '关闭讨论', exact: true }).click()
    await expect(surface(page)).toHaveCount(0)
    await entry.focus()
    await page.keyboard.press('Shift+R')
    await expect(nav).toContainText('1 / 3')
    await expect(item(window, 2)).toHaveClass(/is-active/)
    await expect(page.locator('.react-flow__node[data-id="navigation-a"]')).toHaveClass(/selected/)
    expect(await localComments(page, review.id)).toEqual(review.comments)
  })
}

test('canvas discussion entry browses resolved opinions without mutation and disappears for an empty review', async ({ page }) => {
  let review = fixture()
  for (let number = 1; number <= 4; number++) review = setCommentStatus(review, opinionId(number), 'resolved')
  await openFixture(page, 'zh-CN', review)
  const entry = page.locator('.review-start')
  await expect(entry).toHaveAttribute('aria-label', /查看.*讨论/)
  await expect(entry).toContainText('4')
  await entry.click()
  const window = surface(page), nav = navigation(window)
  await expectPosition(window, 1)
  await expect(item(window, 1)).toHaveClass(/status-resolved/)
  await nav.getByRole('button', { name: nextName, exact: true }).click()
  await expectPosition(window, 2)
  await expect(item(window, 2)).toHaveClass(/status-resolved/)
  await nav.getByRole('button', { name: previousName, exact: true }).click()
  await expectPosition(window, 1)
  expect(await localComments(page, review.id)).toEqual(review.comments)
  const empty = fixture()
  empty.id = 'review-navigation-empty-fixture'
  empty.baseline!.id = empty.id
  empty.comments = []
  await openFixture(page, 'zh-CN', empty)
  await expect(page.locator('.review-start')).toHaveCount(0)
  await expect(surface(page)).toHaveCount(0)
  expect(await localComments(page, empty.id)).toEqual([])
})
