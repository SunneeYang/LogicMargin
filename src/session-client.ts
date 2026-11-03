import { parseReview } from './model.ts'
import { humanFeedback, parseRecordHistory, parseReviewRecord } from './workspace.ts'
import { parsePublication } from './revisions.ts'
import type { CurrentSession, MutationBatch, ReviewMutation, ReviewSession, SnapshotInfo } from './session-types.ts'
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
    const publication = snapshot.publication === undefined ? undefined : parsePublication(snapshot.publication)
    if (publication && publication.baseRound >= Number(snapshot.round)) throw new Error('发布基线必须早于当前图版本')
    return { round: Number(snapshot.round), openedAt: snapshot.openedAt, review: parseReview(snapshot.review), ...(snapshot.afterSubmission === undefined ? {} : { afterSubmission: snapshot.afterSubmission as string }), ...(publication ? { publication } : {}) }
  })
  if (snapshots.length !== Number(source.round) || snapshots.some((snapshot, index) => snapshot.round !== index + 1)) throw new Error('图版本与会话轮次不一致')
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

export function sameVisibleReview(before: ReviewDocument, after: ReviewDocument): boolean {
  const content = (value: ReviewDocument) => {
    const review = parseReview(value)
    for (const comment of review.comments) {
      delete comment.originRound
      delete comment.reviewedRound
      for (const reply of comment.replies ?? []) delete reply.round
    }
    return JSON.stringify(review)
  }
  return content(before) === content(after)
}

export function currentPendingFeedback(review: ReviewDocument, remote: CurrentSession) {
  const submitted = new Set(remote.submittedCommentIds)
  const previous = new Map(remote.review.comments.map(comment => [comment.id, comment]))
  return review.comments.filter(comment => comment.status === 'open' && (!submitted.has(comment.id) ||
    !previous.has(comment.id) || humanFeedback(comment) !== humanFeedback(previous.get(comment.id)!)))
}

export interface PendingSession {
  schemaVersion: 1
  batches: MutationBatch[]
  review: ReviewDocument
}

export function pendingMatchesSession(pending: PendingSession, session: Pick<ReviewSession, 'review' | 'round'>): boolean {
  return pending.review.id === session.review.id && pending.review.revision === session.review.revision &&
    pending.review.snapshot.fingerprint === session.review.snapshot.fingerprint && pending.batches.length > 0 && pending.batches.every(batch =>
    batch.revision === session.review.revision && batch.fingerprint === session.review.snapshot.fingerprint &&
    (batch.round === session.round || (batch.round === undefined && session.round === 1)))
}

export function parsePendingSession(raw: string): PendingSession {
  const value = object(JSON.parse(raw))
  if (value.schemaVersion !== 1 || !Array.isArray(value.batches) || value.batches.length > 2000) throw new Error('待同步记录格式错误，原始记录已保留')
  const review = parseReview(value.review)
  for (const valueBatch of value.batches) {
    const batch = object(valueBatch)
    if (typeof batch.revision !== 'string' || !batch.revision || typeof batch.fingerprint !== 'string' || !batch.fingerprint ||
      (batch.round !== undefined && (!Number.isSafeInteger(batch.round) || Number(batch.round) < 1 || Number(batch.round) > 50)) ||
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
  const value = await requestJson(path, body, signal)
  return value === null ? null : parseSession(value)
}

async function requestJson(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/review-sessions${path}`, body === undefined
    ? { signal, cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (response.status === 204) return null
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = object(value).error
    throw new Error(typeof message === 'string' ? message : `会话服务返回 ${response.status}`)
  }
  return value
}

export function parseCurrentSession(value: unknown): CurrentSession {
  const source = object(value)
  const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200
  const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  const validRound = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 50
  if (source.view !== 'current' || source.schemaVersion !== 1 || !validId(source.id) || !Number.isSafeInteger(source.version) || Number(source.version) < 1 ||
    !validRound(source.round) || !validDate(source.createdAt) || !validDate(source.updatedAt) ||
    !['awaiting-review', 'feedback-ready', 'agent-working', 'approved'].includes(String(source.phase)) ||
    !Array.isArray(source.history) || source.history.length > 50 || !Array.isArray(source.snapshots) || source.snapshots.length !== source.round ||
    !Array.isArray(source.submittedCommentIds) || source.submittedCommentIds.length > 2000 || !Array.isArray(source.commentOrigins) || source.commentOrigins.length > 2000) throw new Error('当前会话格式错误')
  const review = parseReview(source.review)
  const snapshots: SnapshotInfo[] = source.snapshots.map((value, index) => {
    const item = object(value)
    const publication = item.publication === undefined ? undefined : parsePublication(item.publication)
    if (item.round !== index + 1 || !validDate(item.openedAt) || (item.afterSubmission !== undefined && !validId(item.afterSubmission)) || (publication && publication.baseRound >= Number(item.round))) throw new Error('快照目录格式错误')
    return { round: Number(item.round), openedAt: item.openedAt, ...(publication ? { publication } : {}), ...(item.afterSubmission === undefined ? {} : { afterSubmission: String(item.afterSubmission) }) }
  })
  const history = source.history.map(value => {
    const item = object(value)
    if (!validId(item.id) || !['logic-margin-feedback', 'logic-margin-approval'].includes(String(item.kind)) || !validDate(item.createdAt) || !validRound(item.round) || item.round > Number(source.round) || !validId(item.revision) || !validId(item.fingerprint)) throw new Error('评审记录目录格式错误')
    return { id: item.id, kind: item.kind as CurrentSession['history'][number]['kind'], createdAt: item.createdAt, round: item.round, revision: item.revision, fingerprint: item.fingerprint }
  })
  const ids = new Set(review.comments.map(comment => comment.id))
  const submittedCommentIds = source.submittedCommentIds.map(value => { if (!validId(value) || !ids.has(value)) throw new Error('已提交意见目录错误'); return value })
  const commentOrigins = source.commentOrigins.map(value => {
    const item = object(value)
    if (!validId(item.commentId) || !ids.has(item.commentId) || !validRound(item.round) || item.round > Number(source.round) || typeof item.exact !== 'boolean') throw new Error('批注原位置目录错误')
    return { commentId: item.commentId, round: item.round, exact: item.exact }
  })
  for (const values of [history.map(item => item.id), submittedCommentIds, commentOrigins.map(item => item.commentId)]) if (new Set(values).size !== values.length) throw new Error('会话目录标识重复')
  if (snapshots.some(item => item.afterSubmission !== undefined && !history.some(record => record.id === item.afterSubmission)) ||
    review.comments.some(comment => (comment.originRound ?? 1) > Number(source.round) || (comment.reviewedRound ?? 1) > Number(source.round) || comment.replies?.some(reply => (reply.round ?? 1) > Number(source.round)))) throw new Error('会话轮次引用错误')
  if (source.acknowledgedSubmission !== undefined && (!validId(source.acknowledgedSubmission) || !history.some(item => item.id === source.acknowledgedSubmission && item.kind === 'logic-margin-feedback'))) throw new Error('会话接收记录错误')
  return { schemaVersion: 1, view: 'current', id: source.id, version: Number(source.version), round: source.round, phase: source.phase as CurrentSession['phase'],
    createdAt: source.createdAt, updatedAt: source.updatedAt, review, history, snapshots, submittedCommentIds, commentOrigins,
    ...(source.acknowledgedSubmission === undefined ? {} : { acknowledgedSubmission: source.acknowledgedSubmission as string }) }
}

export async function currentRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<CurrentSession | null> {
  const value = await requestJson(`${path}${path.includes('?') ? '&' : '?'}view=current`, body, signal)
  return value === null ? null : parseCurrentSession(value)
}

export async function snapshotRequest(sessionId: string, round: number) {
  const item = object(await requestJson(`/${encodeURIComponent(sessionId)}/snapshots/${round}`))
  if (item.round !== round || typeof item.openedAt !== 'string' || !Number.isFinite(Date.parse(item.openedAt))) throw new Error('历史快照格式错误')
  return parseReview(item.review)
}

export async function recordRequest(sessionId: string, recordId: string) {
  const record = parseReviewRecord(await requestJson(`/${encodeURIComponent(sessionId)}/records/${encodeURIComponent(recordId)}`))
  if (record.id !== recordId) throw new Error('评审记录标识不一致')
  return record
}
