import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseReview, rebaseReview, targetExists } from '../src/model.ts'
import { createApprovalRecord, createFeedbackPackage, parseRecordHistory, pendingFeedback } from '../src/workspace.ts'
import type { ReviewComment, ReviewDocument } from '../src/types.ts'
import type { ReviewSession } from '../src/session-types.ts'

const MAX_SESSION_BYTES = 32 * 1024 * 1024
const phases = ['awaiting-review', 'feedback-ready', 'agent-working', 'approved']
const statuses = ['open', 'needs-review', 'resolved']
export class SessionError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionError('请求必须是对象')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new SessionError('标识无效')
  return value
}
function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new SessionError('会话标识无效')
  return value
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new SessionError(`${label}无效`)
  return value
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new SessionError('会话日期无效')
  return value
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function checkedReview(value: unknown): ReviewDocument { return parseReview(value) }
function parseSession(value: unknown): ReviewSession {
  const source = object(value)
  if (source.schemaVersion !== 1 || typeof source.phase !== 'string' || !phases.includes(source.phase)) throw new SessionError('会话格式无效')
  const review = checkedReview(source.review)
  const history = parseRecordHistory(source.history)
  if (!Array.isArray(source.snapshots) || !source.snapshots.length || source.snapshots.length > 50) throw new SessionError('会话快照无效或超过 50 轮上限')
  const snapshots = source.snapshots.map(value => {
    const snapshot = object(value)
    const afterSubmission = snapshot.afterSubmission === undefined ? undefined : id(snapshot.afterSubmission)
    if (afterSubmission && !history.some(item => item.id === afterSubmission)) throw new SessionError('轮次起点记录不存在')
    return { round: integer(snapshot.round, '轮次'), openedAt: date(snapshot.openedAt), review: checkedReview(snapshot.review), ...(afterSubmission ? { afterSubmission } : {}) }
  })
  const round = integer(source.round, '轮次')
  if (snapshots.length !== round || snapshots.some((item, i) => item.round !== i + 1 || item.review.id !== review.id) || history.some(item => item.review.id !== review.id)) throw new SessionError('会话历史所属评审或轮次不一致')
  const acknowledgedSubmission = source.acknowledgedSubmission === undefined ? undefined : id(source.acknowledgedSubmission)
  if (acknowledgedSubmission && !history.some(item => item.id === acknowledgedSubmission && item.kind === 'logic-margin-feedback')) throw new SessionError('会话接收记录不存在')
  return { schemaVersion: 1, id: sessionId(source.id), version: integer(source.version, '版本'), round,
    phase: source.phase as ReviewSession['phase'], createdAt: date(source.createdAt), updatedAt: date(source.updatedAt), review, history, snapshots,
    ...(acknowledgedSubmission ? { acknowledgedSubmission } : {}) }
}

// shortcut: one service process owns this directory; use a database before running multiple writers.
export class SessionStore {
  dataDir: string
  private serial: Promise<unknown> = Promise.resolve()
  private listeners = new Map<string, Set<() => void>>()
  constructor(dataDir = join(process.cwd(), '.logic-margin', 'sessions')) { this.dataDir = dataDir }
  private path(session: string) { return join(this.dataDir, `${sessionId(session)}.json`) }
  private async load(session: string): Promise<ReviewSession> {
    let raw: string
    try { raw = await readFile(this.path(session), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionError('找不到审查会话', 404); throw error }
    try {
      if (Buffer.byteLength(raw) > MAX_SESSION_BYTES) throw new Error('超过 32 MB 上限')
      const parsed = parseSession(JSON.parse(raw))
      if (parsed.id !== session) throw new Error('文件与会话标识不一致')
      return parsed
    } catch (error) { throw new SessionError(`会话文件损坏，原文件已保留：${error instanceof Error ? error.message : '格式无效'}`, 500) }
  }
  private async persist(session: ReviewSession) {
    const raw = JSON.stringify(session)
    if (Buffer.byteLength(raw) > MAX_SESSION_BYTES) throw new SessionError('会话超过 32 MB，请备份并建立新会话')
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const destination = this.path(session.id)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try { await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination) }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
    for (const listener of this.listeners.get(session.id) ?? []) listener()
  }
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.serial.then(run)
    this.serial = result.catch(() => {})
    return result
  }
  private update(session: string, change: (session: ReviewSession) => ReviewSession): Promise<ReviewSession> {
    return this.queue(async () => {
      const previous = await this.load(session)
      const next = change(structuredClone(previous))
      if (equal(previous, next)) return previous
      next.version = previous.version + 1
      next.updatedAt = new Date().toISOString()
      const checked = parseSession(next)
      await this.persist(checked)
      return checked
    })
  }
  async get(session: string): Promise<ReviewSession> { await this.serial; return this.load(session) }
  create(value: unknown): Promise<ReviewSession> {
    return this.queue(async () => {
      const review = checkedReview(value)
      const now = new Date().toISOString()
      const session: ReviewSession = { schemaVersion: 1, id: randomUUID(), version: 1, round: 1, phase: 'awaiting-review', createdAt: now, updatedAt: now,
        review, history: [], snapshots: [{ round: 1, openedAt: now, review: structuredClone(review) }] }
      await this.persist(session)
      return session
    })
  }
  mutate(session: string, value: unknown): Promise<ReviewSession> {
    const batch = object(value)
    if (!Array.isArray(batch.mutations) || !batch.mutations.length || batch.mutations.length > 200) throw new SessionError('每批需要 1–200 项操作')
    const mutations = batch.mutations.map(object)
    return this.update(session, state => {
      if (batch.revision !== state.review.revision || batch.fingerprint !== state.review.snapshot.fingerprint) throw new SessionError('流程已更新，请恢复会话并核对新版后重试；未保存操作应保留导出', 409)
      if (mutations.some(item => item.kind === 'set-status') && batch.expectedVersion !== state.version) throw new SessionError('批注已有更新，请查看最新回复后再确认状态', 409)
      let review = state.review
      for (const mutation of mutations) {
        if (mutation.kind === 'add-comment') {
          const raw = object(mutation.comment)
          const candidate = checkedReview({ ...review, comments: [raw] }).comments[0]
          const existing = review.comments.find(item => item.id === candidate.id)
          if (existing) {
            if (!equal([existing.body, existing.targets, existing.createdAt, existing.revision], [candidate.body, candidate.targets, candidate.createdAt, candidate.revision])) throw new SessionError('相同批注标识的内容冲突', 409)
            continue
          }
          if (candidate.revision !== review.revision || candidate.status !== 'open' || candidate.replies?.length || candidate.reviewedRevision || candidate.targets.some(target => !targetExists(review, target))) throw new SessionError('新批注必须指向当前版本的现有目标且处于待处理状态')
          review = checkedReview({ ...review, comments: [...review.comments, candidate] })
        } else if (mutation.kind === 'add-reply') {
          const commentId = id(mutation.commentId)
          const comment = review.comments.find(item => item.id === commentId)
          if (!comment) throw new SessionError('找不到此批注', 404)
          const candidate = checkedReview({ ...review, comments: [{ ...comment, replies: [mutation.reply] }] }).comments[0].replies![0]
          const existing = comment.replies?.find(item => item.id === candidate.id)
          if (existing) { if (!equal(existing, candidate)) throw new SessionError('相同回复标识的内容冲突', 409); continue }
          if (candidate.revision !== review.revision) throw new SessionError('回复所属版本已过期', 409)
          review = checkedReview({ ...review, comments: review.comments.map(item => item.id === commentId ? { ...item, replies: [...(item.replies ?? []), candidate], status: candidate.author === 'agent' ? 'needs-review' : item.status } : item) })
        } else if (mutation.kind === 'set-status') {
          if (typeof mutation.status !== 'string' || !statuses.includes(mutation.status) || typeof mutation.from !== 'string' || !statuses.includes(mutation.from)) throw new SessionError('批注状态无效')
          const comment = review.comments.find(item => item.id === mutation.commentId)
          if (!comment) throw new SessionError('找不到此批注', 404)
          if (comment.status !== mutation.from || mutation.reviewedRevision !== review.revision) throw new SessionError('批注状态或版本已有变化，请核对最新内容', 409)
          review = checkedReview({ ...review, comments: review.comments.map(item => item.id === comment.id ? { ...item, status: mutation.status as ReviewComment['status'], reviewedRevision: review.revision } : item) })
        } else throw new SessionError('不支持此会话操作')
      }
      return { ...state, review, phase: !equal(review, state.review) && state.phase === 'approved' ? 'awaiting-review' : state.phase }
    })
  }
  finish(session: string, value: unknown): Promise<ReviewSession> {
    const input = object(value)
    if (input.kind !== 'feedback' && input.kind !== 'approval') throw new SessionError('提交类型无效')
    const submissionId = input.submissionId === undefined ? randomUUID() : id(input.submissionId)
    return this.update(session, state => {
      const duplicate = state.history.find(item => item.id === submissionId)
      if (duplicate) {
        if (state.history.at(-1)?.id !== submissionId || duplicate.kind !== `logic-margin-${input.kind}` || duplicate.review.revision !== state.review.revision || duplicate.review.snapshot.fingerprint !== state.review.snapshot.fingerprint) throw new SessionError('提交标识已被其他轮次使用', 409)
        return state
      }
      if (input.expectedVersion !== state.version) throw new SessionError('会话已有更新，请核对最新批注后重新提交', 409)
      const pending = pendingFeedback(state.review, state.history)
      if (input.kind === 'feedback' && !pending.length) throw new SessionError('没有新的待处理意见可提交')
      const record = input.kind === 'feedback' ? createFeedbackPackage({ ...state.review, comments: pending }) : createApprovalRecord(state.review)
      record.id = submissionId
      return { ...state, history: parseRecordHistory([...state.history, record]), phase: input.kind === 'feedback' ? 'feedback-ready' : 'approved' }
    })
  }
  acknowledge(session: string, value: unknown): Promise<ReviewSession> {
    const submissionId = id(object(value).submissionId)
    return this.update(session, state => {
      const latest = state.history.at(-1)
      if (!latest || latest.id !== submissionId || latest.kind !== 'logic-margin-feedback') throw new SessionError('意见包已更新或不存在，请重新读取', 409)
      if (state.acknowledgedSubmission === submissionId) return state
      if (state.phase !== 'feedback-ready' || latest.review.revision !== state.review.revision || latest.review.snapshot.fingerprint !== state.review.snapshot.fingerprint) throw new SessionError('此意见包属于已结束的轮次，请读取当前轮次', 409)
      return { ...state, acknowledgedSubmission: submissionId, phase: 'agent-working' }
    })
  }
  revise(session: string, value: unknown): Promise<ReviewSession> {
    const input = object(value)
    const review = checkedReview(input.review)
    return this.update(session, state => {
      if (input.expectedVersion !== state.version) throw new SessionError('会话已有更新，请读取最新意见后发布新版', 409)
      if (review.id !== state.review.id) throw new SessionError('只能发布相同评审 ID 的新版')
      if (state.round >= 50) throw new SessionError('会话已达 50 轮，请备份并建立新会话')
      const next = rebaseReview(state.review, review)
      const afterSubmission = state.history.at(-1)?.id
      return { ...state, review: next, round: state.round + 1, phase: 'awaiting-review', snapshots: [...state.snapshots, { round: state.round + 1, openedAt: new Date().toISOString(), review: structuredClone(next), ...(afterSubmission ? { afterSubmission } : {}) }] }
    })
  }
  async waitForChange(session: string, afterVersion: number, waitMs: number, signal?: AbortSignal): Promise<ReviewSession | null> {
    const current = await this.get(session)
    if (current.version !== afterVersion) return current
    return new Promise((resolve, reject) => {
      let ended = false
      const listeners = this.listeners.get(session) ?? new Set<() => void>()
      this.listeners.set(session, listeners)
      const finish = (result: ReviewSession | null, error?: unknown) => {
        if (ended) return
        ended = true; clearTimeout(timer); listeners.delete(changed); signal?.removeEventListener('abort', aborted)
        if (!listeners.size) this.listeners.delete(session)
        if (error) reject(error); else resolve(result)
      }
      const changed = () => { void this.get(session).then(state => { if (state.version !== afterVersion) finish(state) }, error => finish(null, error)) }
      const aborted = () => finish(null)
      const timer = setTimeout(() => finish(null), Math.max(0, Math.min(waitMs, 25000)))
      listeners.add(changed); signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted(); else changed()
    })
  }
}
