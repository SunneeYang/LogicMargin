import { parseReview, parseReviewBaseline } from './model.ts'
import { humanFeedback, parseRecordHistory, parseReviewRecord } from './workspace.ts'
import { parsePublication } from './revisions.ts'
import { parseSessionOptions } from './session-lifecycle.ts'
import type { BaselineInfo, CleanupResult, CurrentSession, MutationBatch, ReviewMutation, ReviewSession, SessionSummary, SnapshotInfo } from './session-types.ts'
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
    !Array.isArray(source.snapshots) ||
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
    review: parseReview(source.review), history: parseRecordHistory(source.history), snapshots, ...parseSessionOptions(source),
    ...(source.acknowledgedSubmission === undefined ? {} : { acknowledgedSubmission: source.acknowledgedSubmission as string }) }
}

export function reviewMutations(before: ReviewDocument, after: ReviewDocument): ReviewMutation[] {
  if (before.id !== after.id || before.revision !== after.revision || before.snapshot.fingerprint !== after.snapshot.fingerprint) throw new Error('请通过代理发布新版流程，不能将批注保存为另一份快照')
  const mutations: ReviewMutation[] = []
  for (const comment of after.comments) {
    const previous = before.comments.find(item => item.id === comment.id)
    if (!previous) { mutations.push({ kind: 'add-comment', comment }); continue }
    if (previous.basis !== comment.basis) throw new Error('已有批注的流程图依据不能修改')
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
    const review = parseReview(value, { allowBaselineReferences: true })
    delete review.baseline
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
  if (value.schemaVersion !== 1 || !Array.isArray(value.batches)) throw new Error('待同步记录格式错误，原始记录已保留')
  const review = parseReview(value.review, { allowBaselineReferences: true })
  for (const valueBatch of value.batches) {
    const batch = object(valueBatch)
    if (typeof batch.revision !== 'string' || !batch.revision || typeof batch.fingerprint !== 'string' || !batch.fingerprint ||
      (batch.round !== undefined && (!Number.isSafeInteger(batch.round) || Number(batch.round) < 1)) ||
      (batch.expectedVersion !== undefined && (!Number.isSafeInteger(batch.expectedVersion) || Number(batch.expectedVersion) < 1)) ||
      !Array.isArray(batch.mutations) || !batch.mutations.length) throw new Error('待同步记录格式错误，原始记录已保留')
    for (const valueMutation of batch.mutations) {
      const mutation = object(valueMutation)
      if (mutation.kind === 'add-comment') {
        parseReview({ ...review, comments: [mutation.comment] }, { allowBaselineReferences: true })
      } else if (mutation.kind === 'add-reply') {
        const comment = review.comments.find(item => item.id === mutation.commentId)
        if (!comment) throw new Error('待同步回复对应批注不存在')
        parseReview({ ...review, comments: [{ ...comment, replies: [mutation.reply] }] }, { allowBaselineReferences: true })
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

export class SessionRequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

async function requestJson(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/review-sessions${path}`, body === undefined
    ? { signal, cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (response.status === 204) return null
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = object(value).error
    throw new SessionRequestError(typeof message === 'string' ? message : `会话服务返回 ${response.status}`, response.status)
  }
  return value
}

export function parseCurrentSession(value: unknown): CurrentSession {
  const source = object(value)
  const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200
  const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  const validRound = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1
  if (source.view !== 'current' || source.schemaVersion !== 1 || !validId(source.id) || !Number.isSafeInteger(source.version) || Number(source.version) < 1 ||
    !validRound(source.round) || !validDate(source.createdAt) || !validDate(source.updatedAt) ||
    !['awaiting-review', 'feedback-ready', 'agent-working', 'approved'].includes(String(source.phase)) ||
    !Array.isArray(source.history) || !Array.isArray(source.snapshots) || source.snapshots.length !== source.round ||
    !Array.isArray(source.submittedCommentIds) || !Array.isArray(source.commentOrigins)) throw new Error('当前会话格式错误')
  const review = parseReview(source.review, { allowBaselineReferences: true })
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
  let baseline: BaselineInfo | undefined
  if (source.baseline !== undefined) {
    const item = object(source.baseline)
    const snapshot = object(item.snapshot)
    if (!validId(item.revision) || typeof snapshot.repository !== 'string' || !snapshot.repository.trim() || snapshot.repository.length > 2000 ||
      !validId(snapshot.commit) || !validId(snapshot.fingerprint) || !validDate(snapshot.capturedAt) || typeof snapshot.dirty !== 'boolean') throw new Error('固定基线摘要格式错误')
    baseline = { revision: item.revision, snapshot: { repository: snapshot.repository, commit: snapshot.commit,
      fingerprint: snapshot.fingerprint, capturedAt: snapshot.capturedAt, dirty: snapshot.dirty } }
  }
  return { schemaVersion: 1, view: 'current', id: source.id, version: Number(source.version), round: source.round, phase: source.phase as CurrentSession['phase'],
    createdAt: source.createdAt, updatedAt: source.updatedAt, review, history, snapshots, submittedCommentIds, commentOrigins, ...parseSessionOptions(source),
    ...(baseline ? { baseline } : {}),
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

export async function baselineRequest(sessionId: string) {
  const item = object(await requestJson(`/${encodeURIComponent(sessionId)}/baseline`))
  return parseReviewBaseline(item.review)
}

export async function recordRequest(sessionId: string, recordId: string) {
  const record = parseReviewRecord(await requestJson(`/${encodeURIComponent(sessionId)}/records/${encodeURIComponent(recordId)}`))
  if (record.id !== recordId) throw new Error('评审记录标识不一致')
  return record
}

export function parseSessionSummary(value: unknown): SessionSummary {
  const item = object(value)
  const validText = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  const validDate = (value: unknown): value is string => validText(value) && Number.isFinite(Date.parse(value))
  if (!validText(item.id) || !validText(item.title) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 ||
    !Number.isSafeInteger(item.round) || Number(item.round) < 1 || !validDate(item.createdAt) || !validDate(item.updatedAt) ||
    !['awaiting-review', 'feedback-ready', 'agent-working', 'approved'].includes(String(item.phase)) ||
    (item.archivedAt !== undefined && !validDate(item.archivedAt))) throw new Error('评审任务列表格式错误')
  return { id: item.id, title: item.title, version: Number(item.version), round: Number(item.round), phase: item.phase as SessionSummary['phase'],
    createdAt: item.createdAt, updatedAt: item.updatedAt, ...parseSessionOptions(item),
    ...(item.archivedAt === undefined ? {} : { archivedAt: item.archivedAt as string }) }
}

export async function listSessions(context?: string, onWarning?: (message: string) => void): Promise<SessionSummary[]> {
  const query = new URLSearchParams({ state: 'all' })
  if (context) query.set('context', context)
  const value = object(await requestJson(`?${query}`))
  if (!Array.isArray(value.sessions)) throw new Error('评审任务列表格式错误')
  if (value.warnings !== undefined) {
    if (!Array.isArray(value.warnings) || value.warnings.some(item => typeof item !== 'string')) throw new Error('评审任务列表警告格式错误')
    if (value.warnings.length) onWarning?.(value.warnings.join('\n'))
  }
  return value.sessions.map(parseSessionSummary)
}

export async function cleanupSession(sessionId: string, expectedVersion: number, mode: 'archive' | 'delete'): Promise<CleanupResult> {
  const result = object(await requestJson(`/${encodeURIComponent(sessionId)}/cleanup`, { expectedVersion, mode }))
  if (result.id !== sessionId || result.mode !== mode || (mode === 'archive' && (typeof result.archivedAt !== 'string' || !Number.isFinite(Date.parse(result.archivedAt))))) throw new Error('清理结果格式错误')
  return { id: sessionId, mode, ...(mode === 'archive' ? { archivedAt: result.archivedAt as string } : {}) }
}
