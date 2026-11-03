import { test, expect } from '@playwright/test'
import { addComment } from '../src/model.ts'
import { sampleReview } from '../src/sample.ts'
import { makeDraft } from '../src/workspace.ts'
import type { ReviewSession } from '../src/session-types.ts'
import type { APIRequestContext } from '@playwright/test'
import { commentScope, openMenu } from './ui.ts'

async function createTask(request: APIRequestContext, context: string, purpose: string) {
  const review = addComment(structuredClone(sampleReview), [{ kind: 'review', id: sampleReview.id }], '另一目的留下的旧意见')
  const response = await request.post('/api/review-sessions', { data: { review, scope: { context, purpose } } })
  expect(response.ok()).toBeTruthy()
  return await response.json() as ReviewSession
}

async function approveTask(request: APIRequestContext, session: ReviewSession) {
  const response = await request.post(`/api/review-sessions/${session.id}/finish`, { data: { expectedVersion: session.version, kind: 'approval' } })
  expect(response.ok()).toBeTruthy()
  return await response.json() as ReviewSession
}

test('different purposes in one Agent context keep separate comments, rounds and browser drafts', async ({ page, request }) => {
  const context = `purpose-isolation-${crypto.randomUUID()}`
  const first = await createTask(request, context, '检查扣费时机')
  const second = await createTask(request, context, '检查失败返回码')
  expect(first.id).not.toBe(second.id)
  expect(first.review.comments).toEqual([])
  expect(second.review.comments).toEqual([])
  await page.goto(`/?session=${first.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await commentScope(page, 'scene')
  await page.getByLabel('问题与预期行为').fill('扣费应只在成功时执行')
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`/api/review-sessions/${first.id}`)).json()).review.comments.length).toBe(1)
  expect((await (await request.get(`/api/review-sessions/${second.id}`)).json()).review.comments).toEqual([])
  await commentScope(page, 'review')
  await page.getByLabel('问题与预期行为').fill('留在原目的的草稿')
  await page.getByRole('button', { name: '稍后继续', exact: true }).click()
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '管理评审任务', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '评审任务', exact: true })
  await expect(dialog.getByRole('article', { name: '检查扣费时机', exact: true })).toBeVisible()
  await expect(dialog.getByRole('article', { name: '检查失败返回码', exact: true })).toBeVisible()
  await dialog.getByLabel('审查目的', { exact: true }).fill('另行检查发奖顺序')
  await dialog.getByRole('button', { name: '建立独立评审', exact: true }).click()
  await expect(page).not.toHaveURL(`/?session=${first.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  const id = new URL(page.url()).searchParams.get('session')!
  const fresh: ReviewSession = await (await request.get(`/api/review-sessions/${id}`)).json()
  expect(fresh.scope).toEqual({ context, purpose: '另行检查发奖顺序' })
  expect(fresh.review.comments).toEqual([])
  expect(fresh.round).toBe(1)
  expect(fresh.history).toEqual([])
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:session:${id}:drafts`) ?? '[]')[0].body, first.id)).toBe('留在原目的的草稿')
  await expect(page.getByRole('button', { name: '草稿 0', exact: true })).toBeVisible()
})

test('completed task can be archived, restored and explicitly deleted without touching another purpose', async ({ page, request }) => {
  const context = `cleanup-isolation-${crypto.randomUUID()}`
  const completed = await approveTask(request, await createTask(request, context, '已经完成的独立审查'))
  const ongoing = await createTask(request, context, '仍在审查的另一目的')
  const path = `/api/review-sessions/${completed.id}`
  await page.goto(`/?session=${completed.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '管理评审任务', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '评审任务', exact: true })
  let task = dialog.getByRole('article', { name: '已经完成的独立审查', exact: true })
  const archivedBackup = page.waitForEvent('download')
  await task.getByRole('button', { name: '备份并归档', exact: true }).click()
  await archivedBackup
  await expect(page.getByRole('heading', { name: '评审任务已归档', exact: true })).toBeVisible()
  expect((await request.get(path)).status()).toBe(410)
  expect((await request.get(`${path}/archive`)).ok()).toBeTruthy()
  expect((await request.get(`/api/review-sessions/${ongoing.id}`)).ok()).toBeTruthy()
  await page.reload()
  await expect(page.getByRole('heading', { name: '评审任务已归档', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '管理评审任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '评审任务', exact: true })
  task = dialog.getByRole('article', { name: '已经完成的独立审查', exact: true })
  await task.getByRole('button', { name: '恢复任务', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '管理评审任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '评审任务', exact: true })
  task = dialog.getByRole('article', { name: '已经完成的独立审查', exact: true })
  await task.getByRole('button', { name: '永久删除', exact: true }).click()
  expect((await request.get(path)).ok()).toBeTruthy()
  const deletedBackup = page.waitForEvent('download')
  await task.getByRole('button', { name: '确认永久删除', exact: true }).click()
  await deletedBackup
  await expect(page.getByRole('heading', { name: '评审任务不存在或已删除', exact: true })).toBeVisible()
  expect((await request.get(path)).status()).toBe(404)
  expect((await request.get(`${path}/archive`)).status()).toBe(404)
  await page.reload()
  await expect(page.getByRole('heading', { name: '评审任务不存在或已删除', exact: true })).toBeVisible()
  expect((await request.get(`/api/review-sessions/${ongoing.id}`)).ok()).toBeTruthy()
})

test('local drafts prevent cleanup and a remotely archived task stops active browser polling', async ({ page, request }) => {
  const completed = await approveTask(request, await createTask(request, `draft-protection-${crypto.randomUUID()}`, '有本机草稿的完成任务'))
  const draft = makeDraft(completed.review, [{ kind: 'review', id: completed.review.id }], '尚未保存的补充意见')
  await page.goto(`/?session=${completed.id}`)
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await page.evaluate(({ id, draft }) => localStorage.setItem(`logic-margin:session:${id}:drafts`, JSON.stringify([draft])), { id: completed.id, draft })
  await page.reload()
  await expect(page.locator('.save-state')).toHaveText('已保存到会话')
  await openMenu(page, '.file-menu')
  await page.getByRole('button', { name: '管理评审任务', exact: true }).click()
  const task = page.getByRole('dialog', { name: '评审任务', exact: true }).getByRole('article', { name: '有本机草稿的完成任务', exact: true })
  await task.getByRole('button', { name: '备份并归档', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('本机草稿或未同步意见')
  const path = `/api/review-sessions/${completed.id}`
  expect((await request.get(path)).ok()).toBeTruthy()
  await page.getByRole('button', { name: '关闭评审任务', exact: true }).click()
  const cleanup = await request.post(`${path}/cleanup`, { data: { expectedVersion: completed.version, mode: 'archive' } })
  expect(cleanup.ok()).toBeTruthy()
  await expect(page.getByRole('heading', { name: '评审任务已归档', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出本机草稿', exact: true })).toBeVisible()
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`logic-margin:session:${id}:drafts`) ?? '[]')[0].body, completed.id)).toBe(draft.body)
})
