import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession } from '../src/session-types.ts'
import { commentScope, openInspector } from './ui.ts'

const opinion = 'R1：功能关闭时必须保留原资源。'
const agentReply = 'R2：已补齐拒绝出口，并确认不会扣除资源。'
const supplement = '补充：请同时保留之前的通关记录。'

async function submittedSession(request: APIRequestContext) {
  const review = structuredClone(sampleReview)
  review.id = 'round-finish-fixture'
  review.title = '本轮复核与提交'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.filter(node => node.sceneId === review.scenes[0].id).slice(0, 3)
    .map(node => ({ ...node, evidence: [] }))
  const ids = new Set(review.nodes.map(node => node.id))
  review.edges = review.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  review.comments = []
  const createdResponse = await request.post('/api/review-sessions', { data: { review } })
  expect(createdResponse.ok()).toBeTruthy()
  const created: ReviewSession = await createdResponse.json()
  const path = `/api/review-sessions/${created.id}`
  const comment = addComment(review, [{ kind: 'node', id: 'upgrade-toggle' }], opinion).comments[0]
  const savedResponse = await request.post(`${path}/mutations`, { data: {
    round: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }],
  } })
  expect(savedResponse.ok()).toBeTruthy()
  const saved: ReviewSession = await savedResponse.json()
  const finishedResponse = await request.post(`${path}/finish`, { data: { expectedVersion: saved.version, kind: 'feedback' } })
  expect(finishedResponse.ok()).toBeTruthy()
  return { path, state: await finishedResponse.json() as ReviewSession, commentId: comment.id }
}

async function secondRound(request: APIRequestContext) {
  const fixture = await submittedSession(request)
  const next = structuredClone(fixture.state.review)
  next.revision = 'round-finish-r2'
  next.nodes[1].summary = '功能关闭时拒绝继续，并保留原资源。'
  const files = [{ path: 'round-finish-fixture.ts', sha256: createHash('sha256').update('round finish verified fixture\n').digest('hex') }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  next.snapshot = { ...next.snapshot, files, fingerprint }
  const response = await request.post(`${fixture.path}/revise`, { data: {
    expectedVersion: fixture.state.version, review: next,
    publication: { baseRound: 1, summary: '补齐功能关闭时的拒绝出口。',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } },
    replies: [{ commentId: fixture.commentId, body: agentReply }],
  } })
  expect(response.ok()).toBeTruthy()
  return { ...fixture, state: await response.json() as ReviewSession }
}

test('the second-round entry guides verification and submits the newly supplemented feedback', async ({ page, request }) => {
  const { path, state } = await secondRound(request)
  const get = async (): Promise<ReviewSession> => (await request.get(path)).json()
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await openInspector(page, 'comments')
  const card = page.getByRole('article', { name: '意见 1', exact: true })
  await expect(card).toContainText(agentReply)
  await card.getByRole('button', { name: '回复讨论', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await editor.getByLabel('补充说明').fill(supplement)
  await editor.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect.poll(async () => (await get()).review.comments[0].replies?.some(reply => reply.body === supplement)).toBe(true)
  expect((await get()).review.comments[0].status).toBe('needs-review')
  await editor.getByRole('button', { name: '关闭讨论', exact: true }).click()
  const topbar = page.locator('.topbar')
  await topbar.getByRole('button', { name: '复核本轮', exact: true }).click()
  await expect(page.locator('.feedback-summary')).toHaveCount(0)
  await expect(card).toBeVisible()
  await expect(card).toHaveClass(/is-active/)
  expect((await get()).phase).toBe('awaiting-review')
  expect((await get()).history).toHaveLength(1)
  expect((await get()).review.comments[0].status).toBe('needs-review')
  await card.getByRole('button', { name: /仍需处理/ }).click()
  await expect.poll(async () => (await get()).review.comments[0].status).toBe('open')
  await topbar.getByRole('button', { name: '提交本轮（1）', exact: true }).click()
  await page.getByRole('button', { name: '提交给代理', exact: true }).click()
  await expect.poll(async () => (await get()).phase).toBe('feedback-ready')
  const completed = await get()
  expect(completed.round).toBe(2)
  expect(completed.history).toHaveLength(2)
  expect(completed.history[1].kind).toBe('logic-margin-feedback')
  expect(completed.history[1].review.comments[0].replies?.some(reply => reply.body === supplement)).toBe(true)
})

test('the second-round entry offers explicit approval after every opinion is resolved', async ({ page, request }) => {
  const { path, state } = await secondRound(request)
  const get = async (): Promise<ReviewSession> => (await request.get(path)).json()
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await openInspector(page, 'comments')
  const card = page.getByRole('article', { name: '意见 1', exact: true })
  await card.getByRole('button', { name: '复核并确认解决', exact: true }).click()
  await expect.poll(async () => (await get()).review.comments[0].status).toBe('resolved')
  expect((await get()).phase).toBe('awaiting-review')
  expect((await get()).history).toHaveLength(1)
  await page.locator('.topbar').getByRole('button', { name: '完成审查', exact: true }).click()
  const confirmation = page.getByRole('region', { name: '完成审查', exact: true })
  await expect(confirmation).toBeVisible()
  expect((await get()).phase).toBe('awaiting-review')
  expect((await get()).history).toHaveLength(1)
  await confirmation.getByRole('button', { name: '确认整轮通过', exact: true }).click()
  await expect.poll(async () => (await get()).phase).toBe('approved')
  const completed = await get()
  expect(completed.round).toBe(2)
  expect(completed.history).toHaveLength(2)
  expect(completed.history[1].kind).toBe('logic-margin-approval')
  await expect(confirmation).not.toBeVisible()
  await expect(page.locator('.topbar-actions').getByText('本轮已通过', { exact: true })).toBeVisible()
})

test('agent work blocks approval while still allowing newly supplemented feedback', async ({ page, request }) => {
  const { path, state } = await submittedSession(request)
  const get = async (): Promise<ReviewSession> => (await request.get(path)).json()
  const response = await request.post(`${path}/ack`, { data: { submissionId: state.history[0].id } })
  expect(response.ok()).toBeTruthy()
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await page.locator('.topbar').getByRole('button', { name: '查看待处理意见', exact: true }).click()
  await expect(page.locator('.feedback-summary')).toHaveCount(0)
  const card = page.getByRole('article', { name: '意见 1', exact: true })
  await expect(card).toHaveClass(/is-active/)
  await expect(card.getByRole('button', { name: /确认解决/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: '确认整轮通过', exact: true })).toHaveCount(0)
  await card.getByRole('button', { name: '回复讨论', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await editor.getByLabel('补充说明').fill(supplement)
  await editor.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect.poll(async () => (await get()).review.comments[0].replies?.some(reply => reply.body === supplement)).toBe(true)
  await page.locator('.topbar').getByRole('button', { name: '提交本轮（1）', exact: true }).click()
  await page.getByRole('button', { name: '提交给代理', exact: true }).click()
  await expect.poll(async () => (await get()).history.length).toBe(2)
  expect((await get()).history[1].kind).toBe('logic-margin-feedback')
})

test('the finish entry is absent on a historical diagram', async ({ page, request }) => {
  const { state } = await secondRound(request)
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await page.getByRole('button', { name: '修改前 R1', exact: true }).click()
  await expect(page.locator('.topbar').getByRole('button', { name: /^(提交本轮|复核本轮|完成审查)/ })).toHaveCount(0)
})

test('already-submitted open opinions remain directly reachable without creating another submission', async ({ page, request }) => {
  const { path, state } = await submittedSession(request)
  const get = async (): Promise<ReviewSession> => (await request.get(path)).json()
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  const entry = page.locator('.topbar').getByRole('button', { name: '查看待处理意见', exact: true })
  await entry.click()
  const card = page.getByRole('article', { name: '意见 1', exact: true })
  await expect(card).toBeVisible()
  await expect(card).toHaveClass(/is-active/)
  await expect(page.locator('.feedback-summary')).toHaveCount(0)
  expect((await get()).history).toHaveLength(1)
  await page.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await entry.click()
  await expect(card).toBeVisible()
  expect((await get()).history).toHaveLength(1)
  await page.reload()
  await entry.click()
  await expect(card).toBeVisible()
  expect((await get()).history).toHaveLength(1)
})

test('an unfinished draft does not block explicit approval and remains unchanged afterwards', async ({ page, request }) => {
  const { path, state } = await secondRound(request)
  const get = async (): Promise<ReviewSession> => (await request.get(path)).json()
  const draftKey = `logic-margin:session:${state.id}:drafts`
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await commentScope(page, 'review')
  await page.getByLabel('问题与预期行为').fill('这份尚未完成的想法继续留在草稿。')
  await page.getByRole('button', { name: '关闭讨论', exact: true }).click()
  const draft = await page.evaluate(key => localStorage.getItem(key), draftKey)
  expect(JSON.parse(draft!)).toHaveLength(1)
  await page.locator('.topbar').getByRole('button', { name: '复核本轮', exact: true }).click()
  await expect(page.locator('.feedback-summary')).toHaveCount(0)
  const card = page.getByRole('article', { name: '意见 1', exact: true })
  await expect(card).toHaveClass(/is-active/)
  await card.getByRole('button', { name: '确认并看下一条', exact: true }).click()
  await expect.poll(async () => (await get()).review.comments[0].status).toBe('resolved')
  await page.locator('.topbar').getByRole('button', { name: '完成审查', exact: true }).click()
  const confirmation = page.getByRole('region', { name: '完成审查', exact: true })
  await confirmation.getByRole('button', { name: '确认整轮通过', exact: true }).click()
  await expect.poll(async () => (await get()).phase).toBe('approved')
  expect((await get()).review.comments).toHaveLength(1)
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBe(draft)
  await page.reload()
  await expect(page.locator('.topbar-actions').getByText('本轮已通过', { exact: true })).toBeVisible()
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBe(draft)
  await openInspector(page, 'drafts')
  await expect(page.locator('.draft-list')).toContainText('这份尚未完成的想法继续留在草稿。')
})
