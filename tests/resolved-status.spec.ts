import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import type { ReviewSession, ReviseRequest } from '../src/session-types.ts'
import type { ReviewDocument } from '../src/types.ts'
import { expectRevision, exportReview, openInspector } from './ui.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function refreshSnapshot(review: ReviewDocument) {
  const files = review.nodes.flatMap(node => node.evidence.map(item => ({
    path: item.path, sha256: hash(`${'\n'.repeat(item.startLine - 1)}${item.code}\n`),
  }))).sort((a, b) => a.path.localeCompare(b.path))
  review.snapshot = { ...review.snapshot, commit: `fixture-${review.revision}`, files,
    fingerprint: hash(JSON.stringify(files)) }
}

function fixture() {
  let review = structuredClone(sampleReview)
  review.id = 'resolved-status-e2e'
  review.title = '跨轮解决状态验收'
  review.revision = 'resolved-v1'
  review.scenes = review.scenes.slice(0, 1)
  review.nodes = review.nodes.slice(0, 2).map((node, index) => {
    const code = `function rule${index}() { return true; }`
    return { ...node, title: `规则 ${index ? 'B' : 'A'}`, detail: `检查规则 ${index ? 'B' : 'A'} 的结果`,
      position: { x: 0, y: index * 210 },
      evidence: [{ path: `rule-${index}.ts`, symbol: `rule${index}`, startLine: 1, endLine: 1, code, digest: hash(code) }] }
  })
  const nodes = new Set(review.nodes.map(node => node.id))
  review.edges = review.edges.filter(edge => nodes.has(edge.source) && nodes.has(edge.target))
  review.comments = []
  refreshSnapshot(review)
  for (const [index, node] of review.nodes.entries()) {
    review = addComment(review, [{ kind: 'node', id: node.id }], `请核对规则 ${index ? 'B' : 'A'}`)
    review.comments.at(-1)!.createdAt = `2026-11-11T00:00:0${index}Z`
  }
  return review
}

async function createSession(request: APIRequestContext) {
  const response = await request.post('/api/review-sessions', { data: { review: fixture() } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const state = await response.json() as ReviewSession
  const path = `/api/review-sessions/${state.id}`
  const get = async () => await (await request.get(path)).json() as ReviewSession
  return { state, path, get }
}

async function commentsPanel(page: Page) {
  const panel = await openInspector(page, 'comments')
  await panel.locator('.comment-filter').getByRole('button', { name: /^全部 / }).click()
  return panel
}

async function openSession(page: Page, state: ReviewSession) {
  await page.goto(`/?session=${state.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  return commentsPanel(page)
}

async function resolve(page: Page, card: Locator, get: () => Promise<ReviewSession>, commentId: string) {
  await card.getByRole('button', { name: /^(确认解决|复核并确认解决)$/ }).click()
  await expect.poll(async () => (await get()).review.comments.find(comment => comment.id === commentId)?.status).toBe('resolved')
  await expect(card).toHaveClass(/status-resolved/)
  const state = await get()
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`logic-margin:session:${id}:pending`), state.id)).toBeNull()
  return state
}

async function publish(request: APIRequestContext, path: string, state: ReviewSession,
  next: ReviewDocument, replies?: ReviseRequest['replies']) {
  refreshSnapshot(next)
  next.comments = []
  const payload: ReviseRequest = { expectedVersion: state.version, review: next, replies,
    publication: { baseRound: state.round, summary: '跨轮状态回归：发布核验后的流程',
      unchangedReason: '图中未变的规则保持原意，仅重新核验源码位置或回应',
      source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(),
        files: next.snapshot.files!, fingerprint: next.snapshot.fingerprint } } }
  const response = await request.post(`${path}/revise`, { data: payload })
  expect(response.ok(), await response.text()).toBeTruthy()
  return await response.json() as ReviewSession
}

test('human resolution survives unrelated new revision and source changes, reload and exported review', async ({ page, request }) => {
  const { state: initial, path, get } = await createSession(request)
  let panel = await openSession(page, initial)
  const [first, second] = initial.review.comments
  let state = await resolve(page, panel.locator(`#thread-${first.id}`), get, first.id)
  const confirmed = structuredClone(state.review.comments[0])
  expect(confirmed).toMatchObject({ status: 'resolved', reviewedRevision: initial.review.revision, reviewedRound: 1 })
  const next = structuredClone(state.review)
  next.revision = 'resolved-v2'
  next.nodes[1].detail = '规则 B 增加拒绝条件，规则 A 保持原样'
  const evidence = next.nodes[1].evidence[0]
  evidence.code = 'function rule1() { return false; }'
  evidence.digest = hash(evidence.code)
  state = await publish(request, path, state, next)
  expect(state.review.snapshot.fingerprint).not.toBe(initial.review.snapshot.fingerprint)
  expect(state.review.comments[0]).toEqual(confirmed)
  await expect(panel.locator(`#thread-${second.id}`)).toHaveClass(/status-needs-review/)
  await expect(panel.locator(`#thread-${first.id}`)).toHaveClass(/status-resolved/)
  await page.reload()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  panel = await commentsPanel(page)
  await expect(panel.locator(`#thread-${first.id}`)).toHaveClass(/status-resolved/)
  await expect(panel.locator(`#thread-${second.id}`)).toHaveClass(/status-needs-review/)
  expect((await get()).review.comments[0]).toEqual(confirmed)
  const current = await (await request.get(`${path}?view=current`)).json()
  expect(current.review.comments[0]).toEqual(confirmed)
  const downloading = page.waitForEvent('download')
  await exportReview(page)
  const stream = await (await downloading).createReadStream()
  expect(stream).not.toBeNull()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const exported = JSON.parse(Buffer.concat(chunks).toString()) as ReviewDocument
  expect(exported.revision).toBe(next.revision)
  expect(exported.comments[0]).toEqual(confirmed)
})

test('moving unchanged source lines preserves resolution while changed source content requires review', async ({ page, request }) => {
  const { state: initial, path, get } = await createSession(request)
  const panel = await openSession(page, initial)
  const first = initial.review.comments[0]
  const card = panel.locator(`#thread-${first.id}`)
  let state = await resolve(page, card, get, first.id)
  const confirmed = structuredClone(state.review.comments[0])
  const moved = structuredClone(state.review)
  moved.revision = 'resolved-moved'
  moved.nodes[0].evidence[0].startLine += 20
  moved.nodes[0].evidence[0].endLine += 20
  state = await publish(request, path, state, moved)
  expect(state.review.comments[0]).toEqual(confirmed)
  await expectRevision(page, moved.revision)
  await expect(card).toHaveClass(/status-resolved/)
  await page.reload()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await commentsPanel(page)
  await expect(card).toHaveClass(/status-resolved/)
  const changed = structuredClone(state.review)
  changed.revision = 'resolved-source-changed'
  const evidence = changed.nodes[0].evidence[0]
  evidence.code = 'function rule0() { return false; }'
  evidence.digest = hash(evidence.code)
  state = await publish(request, path, state, changed)
  expect(state.review.comments[0]).toMatchObject({ status: 'needs-review', reviewedRevision: confirmed.reviewedRevision, reviewedRound: 1 })
  await expect(card).toHaveClass(/status-needs-review/)
})

test('a related rule change and a later agent response each require a new human decision', async ({ page, request }) => {
  const { state: initial, path, get } = await createSession(request)
  const panel = await openSession(page, initial)
  const first = initial.review.comments[0]
  const card = panel.locator(`#thread-${first.id}`)
  let state = await resolve(page, card, get, first.id)
  const changed = structuredClone(state.review)
  changed.revision = 'resolved-rule-changed'
  changed.nodes[0].detail = '规则 A 增加新的拒绝条件'
  state = await publish(request, path, state, changed)
  await expect(card).toHaveClass(/status-needs-review/)
  state = await resolve(page, card, get, first.id)
  const confirmed = structuredClone(state.review.comments[0])
  expect(confirmed).toMatchObject({ reviewedRevision: changed.revision, reviewedRound: 2 })
  const replied = structuredClone(state.review)
  replied.revision = 'resolved-agent-response'
  state = await publish(request, path, state, replied, [{ commentId: first.id, body: '代理补充：请核对这一条的处理结果' }])
  expect(state.review.comments[0]).toMatchObject({ status: 'needs-review', reviewedRevision: confirmed.reviewedRevision, reviewedRound: 2 })
  await expect(card).toHaveClass(/status-needs-review/)
  await expect(card.locator('.reply-card')).toContainText('代理补充：请核对这一条的处理结果')
  await page.reload()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await commentsPanel(page)
  await expect(card).toHaveClass(/status-needs-review/)
  expect((await get()).review.comments[0].reviewedRound).toBe(2)
})
