import { test, expect } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { addComment, addReply } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewMutation, ReviewSession } from '../src/session-types.ts'
import { openInspector } from './ui.ts'

function fixture() {
  const review = structuredClone(sampleReview)
  review.id = 'discussion-edit-e2e'
  review.title = '讨论编辑验收'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.slice(0, 3).map((node, i) => ({ ...node, evidence: [], position: { x: 0, y: i * 210 } }))
  const ids = new Set(review.nodes.map(node => node.id))
  review.edges = review.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  review.comments = []
  return review
}

async function mutate(request: APIRequestContext, path: string, state: ReviewSession, mutations: ReviewMutation[]) {
  const response = await request.post(`${path}/mutations`, { data: { expectedVersion: state.version, round: state.round,
    revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint, mutations } })
  expect(response.ok(), await response.text()).toBeTruthy()
  return await response.json() as ReviewSession
}

async function createSession(request: APIRequestContext, bodies = ['较早的意见', '较晚的意见']) {
  const review = fixture()
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok(), await created.text()).toBeTruthy()
  let state = await created.json() as ReviewSession
  const path = `/api/review-sessions/${state.id}`
  let annotated = review
  for (const [i, body] of bodies.entries()) {
    annotated = addComment(annotated, [{ kind: 'node', id: review.nodes[0].id }], body)
    annotated.comments.at(-1)!.createdAt = new Date(Date.UTC(2026, 10, 11, 0, i)).toISOString()
  }
  state = await mutate(request, path, state, annotated.comments.map(comment => ({ kind: 'add-comment', comment })))
  const get = async () => await (await request.get(path)).json() as ReviewSession
  return { path, state, get }
}

async function reply(request: APIRequestContext, path: string, state: ReviewSession, body: string, author: 'reviewer' | 'agent' = 'reviewer') {
  const commentId = state.review.comments[0].id
  const next = addReply(state.review, commentId, body, author)
  return mutate(request, path, state, [{ kind: 'add-reply', commentId, reply: next.comments[0].replies!.at(-1)! }])
}

async function openSession(page: Page, state: ReviewSession) {
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  return openInspector(page, 'comments')
}

async function edit(card: Locator, body: string, reply = false) {
  const name = reply ? '编辑补充说明' : '编辑讨论内容'
  await card.getByRole('button', { name, exact: true }).click()
  const form = card.getByRole('form', { name, exact: true })
  await form.getByRole('textbox', { name, exact: true }).fill(body)
  await form.getByRole('button', { name: '保存修改', exact: true }).click()
}

test('discussion list stays oldest first while edits preserve identities, timestamps and order after reload', async ({ page, request }) => {
  const { path, state: initial, get } = await createSession(request)
  const state = await reply(request, path, initial, '最初的补充')
  const original = structuredClone(state.review.comments)
  const inspector = await openSession(page, state)
  const bodies = inspector.locator('.comment-body')
  await expect(bodies).toHaveText(['较早的意见', '较晚的意见'])
  const card = inspector.locator(`#thread-${original[0].id}`)
  await edit(card, '较早的意见，修改后仍在原位置')
  await expect.poll(async () => (await get()).review.comments[0].body).toBe('较早的意见，修改后仍在原位置')
  await edit(card.locator('.reply-card'), '补充已直接修改', true)
  await expect.poll(async () => (await get()).review.comments[0].replies![0].body).toBe('补充已直接修改')
  const saved = (await get()).review.comments
  expect(saved).toEqual([{ ...original[0], body: '较早的意见，修改后仍在原位置',
    replies: [{ ...original[0].replies![0], body: '补充已直接修改' }] }, original[1]])
  await page.reload()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await openInspector(page, 'comments')
  await expect(bodies).toHaveText(['较早的意见，修改后仍在原位置', '较晚的意见'])
  await expect(card.locator('.reply-card')).toHaveCount(1)
  await expect(card.locator('.reply-card')).toContainText('补充已直接修改')
  await page.screenshot({ path: 'test-results/discussion-edit-desktop.png' })
})

test('an edit with a lost save response replays after reload without duplicates or a sync conflict', async ({ page, request }) => {
  const { state, get } = await createSession(request, ['保存前的意见'])
  const inspector = await openSession(page, state)
  const pattern = '**/api/review-sessions/*/mutations**'
  await page.route(pattern, async route => {
    const response = await route.fetch()
    expect(response.ok()).toBeTruthy()
    await route.abort('failed')
  })
  const card = inspector.locator(`#thread-${state.review.comments[0].id}`)
  await edit(card, '已写入服务端但响应丢失的修改')
  await expect(page.locator('.save-state')).toHaveText('同步暂停')
  const saved = await get()
  expect(saved.review.comments[0].body).toBe('已写入服务端但响应丢失的修改')
  const pendingKey = `logic-margin:session:${state.id}:pending`
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).not.toBeNull()
  await page.unroute(pattern)
  await page.reload()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull()
  const recovered = await get()
  expect(recovered.version).toBe(saved.version)
  expect(recovered.review.comments).toEqual(saved.review.comments)
})

test('submitted and agent content is read-only while a new reviewer reply in the same thread remains editable', async ({ page, request }) => {
  const { path, state: initial, get } = await createSession(request, ['已提交的意见'])
  let state = await reply(request, path, initial, '已提交的补充')
  const finished = await request.post(`${path}/finish`, { data: { kind: 'feedback', expectedVersion: state.version, submissionId: randomUUID() } })
  expect(finished.ok(), await finished.text()).toBeTruthy()
  state = await finished.json() as ReviewSession
  const history = structuredClone(state.history)
  state = await reply(request, path, state, '本轮新的补充')
  state = await reply(request, path, state, '代理说明不可人工改写', 'agent')
  const inspector = await openSession(page, state)
  const card = inspector.locator(`#thread-${state.review.comments[0].id}`)
  await expect(card.getByRole('button', { name: '编辑讨论内容', exact: true })).toHaveCount(0)
  const replies = card.locator('.reply-card')
  await expect(replies).toHaveCount(3)
  await expect(replies.nth(0).locator('.edit-discussion')).toHaveCount(0)
  await expect(replies.nth(2).locator('.edit-discussion')).toHaveCount(0)
  await edit(replies.nth(1), '本轮补充修改完成', true)
  await expect.poll(async () => (await get()).review.comments[0].replies![1].body).toBe('本轮补充修改完成')
  const saved = await get()
  expect(saved.history).toEqual(history)
  expect(saved.review.comments[0].body).toBe('已提交的意见')
  expect(saved.review.comments[0].replies![0].body).toBe('已提交的补充')
  expect(saved.review.comments[0].replies![2].body).toBe('代理说明不可人工改写')
})

test('unsubmitted previous-round text stays read-only even when the source revision name is unchanged', async ({ page, request }) => {
  const { path, state: initial } = await createSession(request, ['上一轮未提交的意见'])
  const next = structuredClone(initial.review)
  const files = [{ path: 'discussion-fixture.ts', sha256: createHash('sha256').update('synthetic discussion fixture\n').digest('hex') }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  next.snapshot = { ...next.snapshot, files, fingerprint }
  const revised = await request.post(`${path}/revise`, { data: { expectedVersion: initial.version, review: next,
    publication: { baseRound: 1, summary: '进入第二轮测试', unchangedReason: '流程规则不变，仅核验新一轮来源',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } } } })
  expect(revised.ok(), await revised.text()).toBeTruthy()
  let state = await revised.json() as ReviewSession
  expect(state.round).toBe(2)
  state = await reply(request, path, state, '第二轮新补充')
  const inspector = await openSession(page, state)
  const card = inspector.locator(`#thread-${state.review.comments[0].id}`)
  await expect(card.getByRole('button', { name: '编辑讨论内容', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '编辑补充说明', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '修改前 R1', exact: true }).click()
  await expect(page.getByLabel('业务流程画布', { exact: true })).toHaveAttribute('data-readonly', 'true')
  await expect(inspector.locator('.edit-discussion')).toHaveCount(0)
})

test('a concurrent edit keeps the local draft and rejects overwriting newer discussion text', async ({ page, request }) => {
  const { path, state, get } = await createSession(request, ['并发修改前的意见'])
  const inspector = await openSession(page, state)
  const card = inspector.locator(`#thread-${state.review.comments[0].id}`)
  await card.getByRole('button', { name: '编辑讨论内容', exact: true }).click()
  const form = card.getByRole('form', { name: '编辑讨论内容', exact: true })
  const input = form.getByRole('textbox', { name: '编辑讨论内容', exact: true })
  await input.fill('本页尚未保存的修改')
  const added = addComment(state.review, [{ kind: 'node', id: state.review.nodes[0].id }], '并发同步标记').comments.at(-1)!
  await mutate(request, path, state, [
    { kind: 'edit-comment', commentId: state.review.comments[0].id, from: state.review.comments[0].body, body: '另一端已保存的修改' },
    { kind: 'add-comment', comment: added },
  ])
  await expect(inspector.locator('.comment-body')).toHaveText(['并发同步标记'])
  await form.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(form.getByRole('alert')).toHaveText('讨论内容已有更新，请核对最新内容后重试')
  await expect(input).toHaveValue('本页尚未保存的修改')
  expect((await get()).review.comments[0].body).toBe('另一端已保存的修改')
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await expect(card.locator('.comment-body')).toHaveText('另一端已保存的修改')
})

for (const language of ['zh-CN', 'en'] as const) test(`local mobile discussion editing preserves saved content and accessible controls in ${language}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: language === 'en' ? 'light' : 'dark' })
  const review = addComment(fixture(), [{ kind: 'node', id: 'upgrade-start' }], '本地可修改的意见')
  await page.goto('/')
  await page.evaluate(({ review, language }) => {
    localStorage.setItem(`logic-margin:review:${review.id}`, JSON.stringify(review))
    localStorage.setItem('logic-margin:active', review.id)
    localStorage.setItem('logic-margin:language', language)
  }, { review, language })
  await page.reload()
  let inspector: Locator
  if (language === 'zh-CN') inspector = await openInspector(page, 'comments')
  else {
    await page.getByRole('button', { name: /^Review panel(?:\s|$)/ }).click()
    inspector = page.locator('.inspector')
    await inspector.locator('.inspector-tabs').getByRole('button', { name: /^Discussion/ }).click()
  }
  const name = language === 'en' ? 'Edit comment' : '编辑讨论内容'
  const save = language === 'en' ? 'Save changes' : '保存修改'
  const card = inspector.locator(`#thread-${review.comments[0].id}`)
  await card.getByRole('button', { name, exact: true }).click()
  const form = card.getByRole('form', { name, exact: true })
  const input = form.getByRole('textbox', { name, exact: true })
  await expect(input).toBeFocused()
  await input.fill('   ')
  await expect(form.getByRole('button', { name: save, exact: true })).toBeDisabled()
  await input.fill('本地修改后继续保留同一条意见。')
  expect(await input.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  await page.screenshot({ path: `test-results/discussion-edit-mobile-${language}.png` })
  await form.getByRole('button', { name: save, exact: true }).click()
  await expect(card.locator('.comment-body')).toHaveText('本地修改后继续保留同一条意见。')
  const saved = await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!), review.id)
  expect(saved.comments).toEqual([{ ...review.comments[0], body: '本地修改后继续保留同一条意见。' }])
  await page.reload()
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:review:${id}`)!).comments, review.id)).toEqual(saved.comments)
})
