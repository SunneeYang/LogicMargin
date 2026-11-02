import { parseReview } from './model.ts'
import { parseRecordHistory } from './workspace.ts'
import type { MutationBatch, ReviewMutation, ReviewSession } from './session-types.ts'
import type { ReviewDocument } from './types.ts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话数据格式错误')
  return value as Record<string, unknown>
}

export function parseSession(value: unknown): ReviewSession {
  const source = object(value)
  if (source.schemaVersion !== 1 || typeof source.id !== 'string' || !source.id ||
    !Number.isSafeInteger(source.version) || Number(source.version) < 1 ||
    !Number.isSafeInteger(source.round) || Number(source.round) < 1 ||
    !['awaiting-review', 'feedback-ready', 'agent-working', 'approved'].includes(String(source.phase)) ||
    typeof source.createdAt !== 'string' || !Number.isFinite(Date.parse(source.createdAt)) ||
    typeof source.updatedAt !== 'string' || !Number.isFinite(Date.parse(source.updatedAt)) ||
    !Array.isArray(source.snapshots) || source.snapshots.length > 50 ||
    (source.acknowledgedSubmission !== undefined && typeof source.acknowledgedSubmission !== 'string')) throw new Error('会话数据格式错误')
  const snapshots = source.snapshots.map(value => {
    const snapshot = object(value)
    if (!Number.isSafeInteger(snapshot.round) || Number(snapshot.round) < 1 || typeof snapshot.openedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.openedAt))) throw new Error('轮次快照格式错误')
    if (snapshot.afterSubmission !== undefined && typeof snapshot.afterSubmission !== 'string') throw new Error('轮次起点格式错误')
    return { round: Number(snapshot.round), openedAt: snapshot.openedAt, review: parseReview(snapshot.review), ...(snapshot.afterSubmission === undefined ? {} : { afterSubmission: snapshot.afterSubmission as string }) }
  })
  return { schemaVersion: 1, id: source.id, version: Number(source.version), round: Number(source.round),
    phase: source.phase as ReviewSession['phase'], createdAt: source.createdAt, updatedAt: source.updatedAt,
    review: parseReview(source.review), history: parseRecordHistory(source.history), snapshots,
    ...(source.acknowledgedSubmission === undefined ? {} : { acknowledgedSubmission: source.acknowledgedSubmission as string }) }
}

export function reviewMutations(before: ReviewDocument, after: ReviewDocument): ReviewMutation[] {
  if (before.id !== after.id || before.revision !== after.revision || before.snapshot.fingerprint !== after.snapshot.fingerprint) throw new Error('请通过代理发布新版流程，不能将批注保存为另一份快照')
  const mutations: ReviewMutation[] = []
  for (const comment of after.comments) {
    const previous = before.comments.find(item => item.id === comment.id)
    if (!previous) { mutations.push({ kind: 'add-comment', comment }); continue }
    for (const reply of comment.replies ?? []) {
      if (!previous.replies?.some(item => item.id === reply.id)) mutations.push({ kind: 'add-reply', commentId: comment.id, reply })
    }
    if (previous.status !== comment.status || previous.reviewedRevision !== comment.reviewedRevision) {
      mutations.push({ kind: 'set-status', commentId: comment.id, from: previous.status, status: comment.status, reviewedRevision: after.revision })
    }
  }
  return mutations
}

export interface PendingSession {
  schemaVersion: 1
  batches: MutationBatch[]
  review: ReviewDocument
}

export function parsePendingSession(raw: string): PendingSession {
  const value = object(JSON.parse(raw))
  if (value.schemaVersion !== 1 || !Array.isArray(value.batches) || value.batches.length > 2000) throw new Error('待同步记录格式错误，原始记录已保留')
  const review = parseReview(value.review)
  for (const valueBatch of value.batches) {
    const batch = object(valueBatch)
    if (typeof batch.revision !== 'string' || !batch.revision || typeof batch.fingerprint !== 'string' || !batch.fingerprint ||
      (batch.expectedVersion !== undefined && (!Number.isSafeInteger(batch.expectedVersion) || Number(batch.expectedVersion) < 1)) ||
      !Array.isArray(batch.mutations) || !batch.mutations.length || batch.mutations.length > 2000) throw new Error('待同步记录格式错误，原始记录已保留')
    for (const valueMutation of batch.mutations) {
      const mutation = object(valueMutation)
      if (mutation.kind === 'add-comment') {
        parseReview({ ...review, comments: [mutation.comment] })
      } else if (mutation.kind === 'add-reply') {
        const comment = review.comments.find(item => item.id === mutation.commentId)
        if (!comment) throw new Error('待同步回复对应批注不存在')
        parseReview({ ...review, comments: [{ ...comment, replies: [mutation.reply] }] })
      } else if (mutation.kind === 'set-status') {
        if (typeof mutation.commentId !== 'string' || !['open', 'resolved', 'needs-review'].includes(String(mutation.from)) ||
          !['open', 'resolved', 'needs-review'].includes(String(mutation.status)) || typeof mutation.reviewedRevision !== 'string') throw new Error('待同步批注状态错误')
      } else throw new Error('待同步操作类型错误')
    }
  }
  return { schemaVersion: 1, batches: value.batches as MutationBatch[], review }
}

export async function sessionRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<ReviewSession | null> {
  const response = await fetch(`/api/review-sessions${path}`, body === undefined
    ? { signal, cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (response.status === 204) return null
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = object(value).error
    throw new Error(typeof message === 'string' ? message : `会话服务返回 ${response.status}`)
  }
  return parseSession(value)
}
