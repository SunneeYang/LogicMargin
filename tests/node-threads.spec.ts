import { openInspector } from './ui.ts'
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { addComment, addReply } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession } from '../src/session-types.ts'

const firstOpinion = 'R1：功能关闭时应保留原资源。'
const secondOpinion = 'R1：重新进入时也要检查功能资格。'
const firstReply = 'R2：已同步拒绝出口，未扣除资源。'
const secondReply = 'R2：已补齐重新进入校验。'

async function reviewedSession(request: APIRequestContext, reuseRevision = false) {
  const review = structuredClone(sampleReview)
  review.id = 'node-thread-fixture'
  review.title = '节点的跨轮讨论'
  review.scenes = [review.scenes[0]]
  review.nodes = review.nodes.filter(node => node.sceneId === review.scenes[0].id).slice(0, 3)
    .map(node => ({ ...node, evidence: [] }))
  const ids = new Set(review.nodes.map(node => node.id))
  review.edges = review.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  review.comments = []
  const response = await request.post('/api/review-sessions', { data: { review } })
  expect(response.ok()).toBeTruthy()
  const created: ReviewSession = await response.json()
  const path = `/api/review-sessions/${created.id}`
  const comments = [firstOpinion, secondOpinion].map(body => addComment(review, [{ kind: 'node', id: 'upgrade-toggle' }], body).comments[0])
  const other = addComment(review, [{ kind: 'node', id: 'upgrade-start' }], 'R1：入口步骤的独立意见。').comments[0]
  const savedResponse = await request.post(`${path}/mutations`, { data: {
    round: 1, revision: review.revision, fingerprint: review.snapshot.fingerprint,
    mutations: [...comments, other].map(comment => ({ kind: 'add-comment', comment })),
  } })
  expect(savedResponse.ok()).toBeTruthy()
  const saved: ReviewSession = await savedResponse.json()
  const submitted = await request.post(`${path}/finish`, { data: { expectedVersion: saved.version, kind: 'feedback' } })
  expect(submitted.ok()).toBeTruthy()
  const state: ReviewSession = await submitted.json()
  const next = structuredClone(state.review)
  if (!reuseRevision) next.revision = 'node-thread-r2'
  next.nodes[1].summary = '功能关闭时保留原资源，重新进入时仍核对当前资格。'
  const files = [{ path: 'node-thread-fixture.ts', sha256: createHash('sha256').update('node thread verified fixture\n').digest('hex') }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  next.snapshot = { ...next.snapshot, files, fingerprint }
  const published = await request.post(`${path}/revise`, { data: {
    expectedVersion: state.version, review: next,
    publication: { baseRound: 1, summary: '更新功能关闭与重新进入的校验，并保留原意见。',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint } },
    replies: [
      { commentId: comments[0].id, body: firstReply },
      { commentId: comments[1].id, body: secondReply },
      { commentId: other.id, body: 'R2：入口说明已核对。' },
    ],
  } })
  expect(published.ok()).toBeTruthy()
  return { session: await published.json() as ReviewSession, comments }
}

test('selected details open the complete related history in the independent discussion dialog', async ({ page, request }, info) => {
  const { session } = await reviewedSession(request)
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="upgrade-toggle"] .node-title').click()
  const details = await openInspector(page, 'detail')
  await expect(details.locator('.comment-card')).toHaveCount(0)
  await details.getByRole('button', { name: /^查看相关讨论/ }).click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await expect(discussion).toBeVisible()
  await expect(discussion).toContainText(firstOpinion)
  await expect(discussion).toContainText(firstReply)
  await expect(discussion).toContainText(secondOpinion)
  await expect(discussion).toContainText(secondReply)
  await expect(discussion.locator('.comment-card')).toHaveCount(2)
  await expect(discussion).not.toContainText('入口步骤的独立意见')
  await expect(details.getByRole('button', { name: '确认整轮通过', exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('related-discussion.png') })
  const thread = discussion.locator('.comment-card').filter({ hasText: firstOpinion })
  const history = thread.locator('.comment-history')
  const originalVersion = history.getByText(`原意见版本 ${session.review.comments[0].revision}`, { exact: true })
  await expect(history).not.toHaveAttribute('open')
  await expect(originalVersion).toHaveCount(1)
  await expect(originalVersion).not.toBeVisible()
  await expect(thread.getByText(firstOpinion, { exact: true })).toBeVisible()
  await expect(thread.getByText(firstReply, { exact: true })).toBeVisible()
  await history.locator(':scope > summary').click()
  await expect(originalVersion).toBeVisible()
  await history.getByRole('button', { name: '查看提出时流程', exact: true }).click()
  await expect(page.getByRole('button', { name: '修改前 R1', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.canvas')).toHaveAttribute('data-readonly', 'true')
})

test('a node comment badge opens its threads even when the discussion list has another status filter', async ({ page, request }) => {
  const { session } = await reviewedSession(request, true)
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await openInspector(page, 'comments')
  await page.locator('.comment-filter').getByRole('button', { name: '已确认解决', exact: true }).click()
  await expect(page.locator('.inspector .comment-card')).toHaveCount(0)
  const width = (await page.locator('.canvas').boundingBox())!.width
  const badge = page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true })
  await badge.click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await expect(discussion).toBeVisible()
  expect(await discussion.evaluate(element => !!element.closest('.inspector'))).toBe(false)
  await expect(discussion).toContainText(firstOpinion)
  await expect(discussion).toContainText(firstReply)
  await expect(discussion).toContainText(secondOpinion)
  await expect(discussion).toContainText(secondReply)
  await expect(discussion.locator('.comment-card')).toHaveCount(2)
  await expect(discussion).not.toContainText('入口步骤的独立意见')
  await expect(page.locator('.inspector.is-open')).toBeVisible()
  await expect(page.locator('.inspector-tabs').getByRole('button', { name: '讨论 3', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.comment-filter').getByRole('button', { name: '已确认解决', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.inspector .comment-card')).toHaveCount(0)
  expect((await page.locator('.canvas').boundingBox())!.width).toBeCloseTo(width, 0)
  await page.keyboard.press('Escape')
  await expect(discussion).not.toBeVisible()
  await expect(badge).toBeFocused()
})

test('a node badge retains every attached opinion and reply across a new revision', async ({ page, request }, info) => {
  const { session, comments } = await reviewedSession(request)
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const width = (await page.locator('.canvas').boundingBox())!.width
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await expect(discussion).toBeVisible()
  await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
  expect((await page.locator('.canvas').boundingBox())!.width).toBeCloseTo(width, 0)
  for (const [index, body] of [firstOpinion, secondOpinion].entries()) {
    const card = discussion.locator(`#discussion-thread-${comments[index].id}`)
    await expect(card).toBeVisible()
    await expect(card).toContainText(body)
    await expect(card).toContainText(index === 0 ? firstReply : secondReply)
    await expect(card).toContainText('提出于 R1')
  }
  const first = discussion.locator(`#discussion-thread-${comments[0].id}`)
  const second = discussion.locator(`#discussion-thread-${comments[1].id}`)
  await page.screenshot({ path: info.outputPath('discussion-dialog.png') })
  await first.getByRole('button', { name: '复核并确认解决', exact: true }).click()
  await expect(first).toHaveClass(/status-resolved/)
  await discussion.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  await expect(first).toContainText(firstOpinion)
  await expect(first).toContainText(firstReply)
  await expect(first).toHaveClass(/status-resolved/)
  await first.getByRole('button', { name: '重新打开', exact: true }).click()
  await expect(first).toHaveClass(/status-open/)
  await first.getByRole('button', { name: '确认解决', exact: true }).click()
  await expect(first).toHaveClass(/status-resolved/)
  await second.getByRole('button', { name: '复核后仍需处理', exact: true }).click()
  await expect(second).toHaveClass(/status-open/)
  await page.getByRole('button', { name: '修改前 R1', exact: true }).click()
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  await expect(discussion.locator('.comment-card')).toHaveCount(2)
  await expect(first).toContainText(firstReply)
  await expect(first.getByRole('button', { name: '重新打开', exact: true })).toBeDisabled()
  await expect(second.getByRole('button', { name: '确认解决', exact: true })).toBeDisabled()
  await expect(first.getByRole('button', { name: '回复讨论', exact: true })).toBeDisabled()
})

test('a discussion reply stays in the dialog, targets the chosen opinion and restores an unfinished reply', async ({ page, request }) => {
  const { session, comments } = await reviewedSession(request)
  const path = `/api/review-sessions/${session.id}`
  const get = async (): Promise<ReviewSession> => (await request.get(path)).json()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  const badge = page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true })
  await badge.click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await expect(discussion).toBeVisible()
  const second = discussion.locator(`#discussion-thread-${comments[1].id}`)
  await second.getByRole('button', { name: '回复讨论', exact: true }).click()
  await expect(discussion.getByLabel('补充说明', { exact: true })).toBeInViewport({ ratio: 1 })
  const reply = '仅补充第二条意见的复核依据。'
  await discussion.getByLabel('补充说明', { exact: true }).fill(reply)
  await discussion.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect.poll(async () => (await get()).review.comments.find(comment => comment.id === comments[1].id)?.replies?.some(item => item.body === reply)).toBe(true)
  expect((await get()).review.comments.find(comment => comment.id === comments[0].id)?.replies?.some(item => item.body === reply)).toBe(false)
  await expect(discussion).toBeVisible()
  await expect(second).toContainText(reply)
  await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
  await expect(discussion.getByRole('button', { name: '移到侧栏编辑', exact: true })).toHaveCount(0)
  const first = discussion.locator(`#discussion-thread-${comments[0].id}`)
  await first.getByRole('button', { name: '回复讨论', exact: true }).click()
  await expect(discussion.getByLabel('补充说明', { exact: true })).toBeInViewport({ ratio: 1 })
  const unfinished = '尚未写完，重新打开时继续。'
  await discussion.getByLabel('补充说明', { exact: true }).fill(unfinished)
  await page.keyboard.press('Escape')
  await expect(discussion).not.toBeVisible()
  await expect(badge).toBeFocused()
  const drafts = await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:session:${id}:drafts`)!), session.id)
  expect(drafts).toHaveLength(1)
  expect(drafts[0]).toMatchObject({ body: unfinished, replyTo: comments[0].id, targets: [{ kind: 'node', id: 'upgrade-toggle' }] })
  await badge.click()
  await first.getByRole('button', { name: '回复讨论', exact: true }).click()
  await expect(discussion.getByLabel('补充说明', { exact: true })).toHaveValue(unfinished)
})

test('the independent discussion remains inside a narrow dark viewport', async ({ page, request }, info) => {
  const { session } = await reviewedSession(request)
  await page.setViewportSize({ width: 320, height: 812 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  await expect(discussion).toBeInViewport({ ratio: 1 })
  const bounds = await discussion.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await expect(discussion).toContainText(firstOpinion)
  await expect(discussion).toContainText(secondReply)
  await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
  await page.screenshot({ path: info.outputPath('discussion-dialog-mobile-dark.png') })
  await discussion.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await expect(discussion).not.toBeVisible()
})

test('a discussion shows work in progress while keeping resolution blocked until publication', async ({ page, request }) => {
  const { session, comments } = await reviewedSession(request)
  const response = addReply(session.review, comments[0].id, '正在修改实现，尚未发布新流程。', 'agent')
  const pending = await request.post(`/api/review-sessions/${session.id}/mutations`, { data: {
    round: session.round, revision: session.review.revision, fingerprint: session.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-reply', commentId: comments[0].id, reply: response.comments[0].replies!.at(-1) }],
  } })
  expect(pending.ok()).toBeTruthy()
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  const discussion = page.getByRole('dialog', { name: '节点讨论', exact: true })
  const first = discussion.locator(`#discussion-thread-${comments[0].id}`)
  await expect(first).toContainText('正在修改实现，尚未发布新流程。')
  await expect(first.getByRole('button', { name: '复核并确认解决', exact: true })).toBeDisabled()
  await expect(first.getByRole('button', { name: '复核后仍需处理', exact: true })).toBeDisabled()
  await expect(first.getByRole('button', { name: '回复讨论', exact: true })).toBeEnabled()
  await expect(page.locator('.inspector')).not.toHaveClass(/is-open/)
})
