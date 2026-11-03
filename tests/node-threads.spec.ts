import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { addComment } from '../src/model.ts'
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

test('selecting a node and opening its details shows its previous opinions and agent replies', async ({ page, request }) => {
  const { session } = await reviewedSession(request)
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="upgrade-toggle"] .node-title').click()
  await page.getByRole('button', { name: '步骤详情', exact: true }).click()
  const details = page.locator('.inspector.is-open')
  await expect(details.getByRole('region', { name: '所选对象的相关讨论', exact: true })).toBeVisible()
  await expect(details).toContainText(firstOpinion)
  await expect(details).toContainText(firstReply)
  await expect(details).toContainText(secondOpinion)
  await expect(details).toContainText(secondReply)
  await expect(details.locator('.target-discussions .comment-card')).toHaveCount(2)
  await expect(details.locator('.target-discussions')).not.toContainText('入口步骤的独立意见')
  await page.screenshot({ path: 'artifacts/node-threads/related-discussion.png' })
})

test('a node comment badge opens its threads even when the discussion list has another status filter', async ({ page, request }) => {
  const { session } = await reviewedSession(request, true)
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.graph-toolbar').getByRole('button', { name: '批注 3', exact: true }).click()
  await page.locator('.comment-filter').getByRole('button', { name: '已确认解决', exact: true }).click()
  await expect(page.locator('.inspector .comment-card')).toHaveCount(0)
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  const details = page.locator('.inspector.is-open')
  await expect(details.locator('.inspector-tabs').getByRole('button', { name: '详情', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(details).toContainText(firstOpinion)
  await expect(details).toContainText(firstReply)
  await expect(details).toContainText(secondOpinion)
  await expect(details).toContainText(secondReply)
  await expect(details.locator('.target-discussions .comment-card')).toHaveCount(2)
  await details.getByRole('button', { name: '查看全部讨论', exact: true }).click()
  await expect(details.locator('.comment-card')).toHaveCount(3)
})

test('a node badge retains every attached opinion and reply across a new revision', async ({ page, request }) => {
  const { session, comments } = await reviewedSession(request)
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  for (const [index, body] of [firstOpinion, secondOpinion].entries()) {
    const card = page.locator(`#thread-${comments[index].id}`)
    await expect(card).toBeVisible()
    await expect(card).toContainText(body)
    await expect(card).toContainText(index === 0 ? firstReply : secondReply)
    await expect(card).toContainText('提出于 R1')
  }
  const first = page.locator(`#thread-${comments[0].id}`)
  await first.getByRole('button', { name: '复核并确认解决', exact: true }).click()
  await expect(first).toHaveClass(/status-resolved/)
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  await expect(first).toContainText(firstOpinion)
  await expect(first).toContainText(firstReply)
  await expect(first).toHaveClass(/status-resolved/)
  await page.getByRole('button', { name: '修改前 R1', exact: true }).click()
  await page.getByRole('button', { name: '批注：通灵功能是否开放？（2 条）', exact: true }).click()
  await expect(page.locator('.target-discussions .comment-card')).toHaveCount(2)
  await expect(first).toContainText(firstReply)
  await expect(first.getByRole('button', { name: '重新打开', exact: true })).toBeDisabled()
})
