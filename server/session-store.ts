import { readFile, rename, mkdir, open, stat, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addReply, parseReview, rebaseReview, targetExists } from '../src/model.ts'
import { logicIdentity } from '../src/revisions.ts'
import { validatePublication } from './publication.ts'
import { currentSession } from './session-view.ts'
import { createApprovalRecord, createFeedbackPackage, parseRecordHistory, pendingFeedback } from '../src/workspace.ts'
import type { ReviewComment, ReviewDocument, ReviewRecord } from '../src/types.ts'
import type { CurrentSession, ReviewSession, ReviewSnapshot } from '../src/session-types.ts'

const MAX_SESSION_BYTES = 32 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_CACHE_ENTRIES = 16
type View = 'current' | undefined
type Result<V extends View> = V extends 'current' ? CurrentSession : ReviewSession
interface CachedSession { state: ReviewSession; signature: string; bytes: number; current?: CurrentSession }
const signature = (value: BigIntStats) => `${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
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
function checkCommentRounds(review: ReviewDocument, round: number) {
  if (review.comments.some(comment => (comment.originRound ?? 1) > round || (comment.reviewedRound ?? 1) > round || comment.replies?.some(reply => (reply.round ?? 1) > round))) throw new SessionError('批注所属轮次超出流程版本')
}
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
    const round = integer(snapshot.round, '轮次')
    const review = checkedReview(snapshot.review)
    checkCommentRounds(review, round)
    const publication = snapshot.publication === undefined ? undefined : validatePublication(snapshot.publication, review)
    if (publication && publication.baseRound >= round) throw new SessionError('发布基线必须指向更早的流程快照')
    return { round, openedAt: date(snapshot.openedAt), review, ...(afterSubmission ? { afterSubmission } : {}), ...(publication ? { publication } : {}) }
  })
  const round = integer(source.round, '轮次')
  checkCommentRounds(review, round)
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
  private serial = new Map<string, Promise<void>>()
  private loading = new Map<string, Promise<ReviewSession>>()
  private cache = new Map<string, CachedSession>()
  private cacheBytes = 0
  private listeners = new Map<string, Set<(state: ReviewSession) => void>>()
  constructor(dataDir = join(process.cwd(), '.logic-margin', 'sessions')) { this.dataDir = dataDir }
  private path(session: string) { return join(this.dataDir, `${sessionId(session)}.json`) }
  private forget(session: string) {
    const entry = this.cache.get(session)
    if (entry) { this.cacheBytes -= entry.bytes; this.cache.delete(session) }
  }
  private remember(state: ReviewSession, metadata: BigIntStats, bytes: number) {
    this.forget(state.id)
    this.cache.set(state.id, { state, signature: signature(metadata), bytes })
    this.cacheBytes += bytes
    // The budget uses serialized bytes; parsed objects also obey the schema's item limits.
    while (this.cacheBytes > MAX_CACHE_BYTES || this.cache.size > MAX_CACHE_ENTRIES) this.forget(this.cache.keys().next().value!)
  }
  private async load(session: string): Promise<ReviewSession> {
    const path = this.path(session)
    let metadata: BigIntStats
    try { metadata = await stat(path, { bigint: true }) }
    catch (error) { this.forget(session); if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionError('找不到审查会话', 404); throw error }
    const cached = this.cache.get(session)
    if (cached?.signature === signature(metadata)) {
      this.cache.delete(session); this.cache.set(session, cached)
      return cached.state
    }
    this.forget(session)
    const loading = this.loading.get(session)
    if (loading) return loading
    const operation = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!metadata.isFile() || metadata.size > BigInt(MAX_SESSION_BYTES)) throw new Error('不是会话文件或超过 32 MB 上限')
          const raw = await readFile(path, 'utf8')
          const after = await stat(path, { bigint: true })
          if (signature(metadata) !== signature(after)) { metadata = after; continue }
          const parsed = parseSession(JSON.parse(raw))
          if (parsed.id !== session) throw new Error('文件与会话标识不一致')
          this.remember(parsed, after, Buffer.byteLength(raw))
          return parsed
        }
        throw new Error('会话文件正在被其他进程修改，请稍后重试')
      } catch (error) { throw new SessionError(`会话文件损坏，原文件已保留：${error instanceof Error ? error.message : '格式无效'}`, 500) }
    })()
    this.loading.set(session, operation)
    try { return await operation } finally { if (this.loading.get(session) === operation) this.loading.delete(session) }
  }
  private async persist(session: ReviewSession) {
    const raw = JSON.stringify(session)
    if (Buffer.byteLength(raw) > MAX_SESSION_BYTES) throw new SessionError('会话超过 32 MB，请备份并建立新会话')
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const destination = this.path(session.id)
    const temporary = `${destination}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    let committed: BigIntStats | undefined
    try {
      await file.writeFile(raw)
      const written = await file.stat({ bigint: true })
      await rename(temporary, destination)
      const destinationMetadata = await stat(destination, { bigint: true })
      const ownMetadata = await file.stat({ bigint: true })
      if (written.ino === ownMetadata.ino && written.size === ownMetadata.size && written.mtimeNs === ownMetadata.mtimeNs && signature(ownMetadata) === signature(destinationMetadata)) {
        committed = ownMetadata
      }
    }
    finally { await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
    if (committed) this.remember(session, committed, Buffer.byteLength(raw)); else this.forget(session.id)
    for (const listener of this.listeners.get(session.id) ?? []) listener(session)
  }
  private queue<T>(session: string, run: () => Promise<T>): Promise<T> {
    const result = (this.serial.get(session) ?? Promise.resolve()).then(run)
    const serial = result.then(() => {}, () => {})
    this.serial.set(session, serial)
    void serial.then(() => { if (this.serial.get(session) === serial) this.serial.delete(session) })
    return result
  }
  private output<V extends View>(state: ReviewSession, view?: V): Result<V> {
    const entry = this.cache.get(state.id)
    const value = view === 'current' ? entry?.state === state ? entry.current ??= currentSession(state) : currentSession(state) : state
    return structuredClone(value) as Result<V>
  }
  private update<V extends View>(session: string, change: (session: ReviewSession) => ReviewSession, view?: V): Promise<Result<V>> {
    return this.queue(session, async () => {
      const previous = await this.load(session)
      // Transition callbacks build new current fields; validated history and snapshots stay immutable.
      const next = change(previous)
      if (next.review === previous.review && next.history === previous.history && next.snapshots === previous.snapshots && next.phase === previous.phase && next.acknowledgedSubmission === previous.acknowledgedSubmission) return this.output(previous, view)
      next.version = previous.version + 1
      next.updatedAt = new Date().toISOString()
      checkCommentRounds(next.review, next.round)
      await this.persist(next)
      return this.output(next, view)
    })
  }
  async get<V extends View = undefined>(session: string, view?: V): Promise<Result<V>> { await this.serial.get(session); return this.output(await this.load(session), view) }
  async getSnapshot(session: string, round: number): Promise<ReviewSnapshot> {
    integer(round, '轮次')
    await this.serial.get(session)
    const snapshot = (await this.load(session)).snapshots.find(item => item.round === round)
    if (!snapshot) throw new SessionError('找不到这个流程版本', 404)
    return structuredClone(snapshot)
  }
  async getRecord(session: string, recordId: string): Promise<ReviewRecord> {
    id(recordId)
    await this.serial.get(session)
    const record = (await this.load(session)).history.find(item => item.id === recordId)
    if (!record) throw new SessionError('找不到这个评审记录', 404)
    return structuredClone(record)
  }
  create<V extends View = undefined>(value: unknown, view?: V): Promise<Result<V>> {
    const sessionKey = randomUUID()
    return this.queue(sessionKey, async () => {
      const incoming = checkedReview(value)
      const review = { ...incoming, comments: incoming.comments.map(comment => ({ ...comment, originRound: 1,
        ...(comment.reviewedRound === undefined ? {} : { reviewedRound: 1 }),
        ...(comment.replies === undefined ? {} : { replies: comment.replies.map(reply => ({ ...reply, round: 1 })) }) })) }
      const now = new Date().toISOString()
      const session: ReviewSession = { schemaVersion: 1, id: sessionKey, version: 1, round: 1, phase: 'awaiting-review', createdAt: now, updatedAt: now,
        review, history: [], snapshots: [{ round: 1, openedAt: now, review: structuredClone(review) }] }
      await this.persist(session)
      return this.output(session, view)
    })
  }
  mutate<V extends View = undefined>(session: string, value: unknown, view?: V): Promise<Result<V>> {
    const batch = object(value)
    if (!Array.isArray(batch.mutations) || !batch.mutations.length || batch.mutations.length > 200) throw new SessionError('每批需要 1–200 项操作')
    const mutations = batch.mutations.map(object)
    return this.update(session, state => {
      if (batch.revision !== state.review.revision || batch.fingerprint !== state.review.snapshot.fingerprint) throw new SessionError('流程已更新，请恢复会话并核对新版后重试；未保存操作应保留导出', 409)
      if ((state.round > 1 || batch.round !== undefined) && batch.round !== state.round) throw new SessionError('流程轮次已更新或未提供，请查看当前版本后重试', 409)
      if (mutations.some(item => item.kind === 'set-status') && batch.expectedVersion !== state.version) throw new SessionError('批注已有更新，请查看最新回复后再确认状态', 409)
      let review = state.review
      let awaitingPublication = state.phase === 'agent-working' || state.phase === 'feedback-ready'
      let hasAgentReply = false
      for (const mutation of mutations) {
        if (mutation.kind === 'add-comment') {
          const raw = object(mutation.comment)
          const candidate = checkedReview({ ...review, comments: [raw] }).comments[0]
          const existing = review.comments.find(item => item.id === candidate.id)
          if (existing) {
            if (!equal([existing.body, existing.targets, existing.createdAt, existing.revision], [candidate.body, candidate.targets, candidate.createdAt, candidate.revision])) throw new SessionError('相同批注标识的内容冲突', 409)
            continue
          }
          if (candidate.revision !== review.revision || candidate.status !== 'open' || candidate.replies?.length || candidate.reviewedRevision || candidate.reviewedRound !== undefined || candidate.targets.some(target => !targetExists(review, target))) throw new SessionError('新批注必须指向当前版本的现有目标且处于待处理状态')
          review = checkedReview({ ...review, comments: [...review.comments, { ...candidate, originRound: state.round }] })
        } else if (mutation.kind === 'add-reply') {
          const commentId = id(mutation.commentId)
          const comment = review.comments.find(item => item.id === commentId)
          if (!comment) throw new SessionError('找不到此批注', 404)
          const candidate = checkedReview({ ...review, comments: [{ ...comment, replies: [mutation.reply] }] }).comments[0].replies![0]
          const existing = comment.replies?.find(item => item.id === candidate.id)
          if (existing) {
            if (!equal([existing.author, existing.body, existing.createdAt, existing.revision], [candidate.author, candidate.body, candidate.createdAt, candidate.revision])) throw new SessionError('相同回复标识的内容冲突', 409)
            continue
          }
          if (candidate.revision !== review.revision) throw new SessionError('回复所属版本已过期', 409)
          if (candidate.author === 'agent') { hasAgentReply = true; awaitingPublication = true }
          review = checkedReview({ ...review, comments: review.comments.map(item => item.id === commentId ? { ...item, replies: [...(item.replies ?? []), { ...candidate, round: state.round }], status: candidate.author === 'agent' ? 'needs-review' : item.status } : item) })
        } else if (mutation.kind === 'set-status') {
          if (typeof mutation.status !== 'string' || !statuses.includes(mutation.status) || typeof mutation.from !== 'string' || !statuses.includes(mutation.from)) throw new SessionError('批注状态无效')
          const comment = review.comments.find(item => item.id === mutation.commentId)
          if (!comment) throw new SessionError('找不到此批注', 404)
          if (mutation.status === 'resolved' && awaitingPublication) throw new SessionError('代理处理中，新版流程尚未发布，不能确认解决', 409)
          if (comment.status !== mutation.from || mutation.reviewedRevision !== review.revision) throw new SessionError('批注状态或版本已有变化，请核对最新内容', 409)
          if (comment.status === mutation.status && comment.reviewedRevision === review.revision && comment.reviewedRound === state.round) continue
          review = checkedReview({ ...review, comments: review.comments.map(item => item.id === comment.id ? { ...item, status: mutation.status as ReviewComment['status'], reviewedRevision: review.revision, reviewedRound: state.round } : item) })
        } else throw new SessionError('不支持此会话操作')
      }
      return { ...state, review, phase: hasAgentReply ? 'agent-working' : review !== state.review && state.phase === 'approved' ? 'awaiting-review' : state.phase }
    }, view)
  }
  finish<V extends View = undefined>(session: string, value: unknown, view?: V): Promise<Result<V>> {
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
      if (input.kind === 'approval' && (state.phase === 'agent-working' || state.phase === 'feedback-ready')) throw new SessionError('新版流程尚未发布，不能确认整轮通过', 409)
      const pending = pendingFeedback(state.review, state.history)
      if (input.kind === 'feedback' && !pending.length) throw new SessionError('没有新的待处理意见可提交')
      const record = input.kind === 'feedback' ? createFeedbackPackage({ ...state.review, comments: pending }) : createApprovalRecord(state.review)
      record.id = submissionId
      if (state.history.length >= 50) throw new SessionError('评审历史最多 50 项，请先备份并归档历史')
      return { ...state, history: [...state.history, ...parseRecordHistory([record])], phase: input.kind === 'feedback' ? 'feedback-ready' : 'approved' }
    }, view)
  }
  acknowledge<V extends View = undefined>(session: string, value: unknown, view?: V): Promise<Result<V>> {
    const submissionId = id(object(value).submissionId)
    return this.update(session, state => {
      const latest = state.history.at(-1)
      if (!latest || latest.id !== submissionId || latest.kind !== 'logic-margin-feedback') throw new SessionError('意见包已更新或不存在，请重新读取', 409)
      if (state.acknowledgedSubmission === submissionId) return state
      if (state.phase !== 'feedback-ready' || latest.review.revision !== state.review.revision || latest.review.snapshot.fingerprint !== state.review.snapshot.fingerprint) throw new SessionError('此意见包属于已结束的轮次，请读取当前轮次', 409)
      return { ...state, acknowledgedSubmission: submissionId, phase: 'agent-working' }
    }, view)
  }
  revise<V extends View = undefined>(session: string, value: unknown, view?: V): Promise<Result<V>> {
    const input = object(value)
    const review = checkedReview(input.review)
    return this.update(session, state => {
      if (input.expectedVersion !== state.version) throw new SessionError('会话已有更新，请读取最新意见后发布新版', 409)
      if (review.id !== state.review.id) throw new SessionError('只能发布相同评审 ID 的新版')
      if (state.round >= 50) throw new SessionError('会话已达 50 轮，请备份并建立新会话')
      const publication = validatePublication(input.publication, review)
      if (publication.baseRound !== state.round) throw new SessionError('发布基线不是当前固定流程，请重新读取本轮意见', 409)
      if (logicIdentity(state.review) === logicIdentity(review) && !publication.unchangedReason) throw new SessionError('流程没有逻辑变化，请说明流程未变的原因')
      const round = state.round + 1
      let next = rebaseReview(state.review, review)
      const previous = new Map(state.review.comments.map(comment => [comment.id, comment]))
      next = { ...next, comments: next.comments.map(comment => {
        const original = previous.get(comment.id)
        const replies = comment.replies?.map(reply => original?.replies?.some(item => item.id === reply.id) ? reply : { ...reply, round })
        return { ...comment, ...(original ? {} : { originRound: round, ...(comment.reviewedRound === undefined ? {} : { reviewedRound: round }) }),
          ...(replies === undefined ? {} : { replies }) }
      }) }
      if (input.replies !== undefined) {
        if (!Array.isArray(input.replies) || input.replies.length > 2000) throw new SessionError('发布回应最多 2000 项')
        for (const value of input.replies) {
          const reply = object(value)
          const commentId = id(reply.commentId)
          if (typeof reply.body !== 'string') throw new SessionError('发布回应必须是文本')
          next = addReply(next, commentId, reply.body, 'agent')
          next = { ...next, comments: next.comments.map(comment => comment.id === commentId ? { ...comment,
            replies: comment.replies!.map((item, index) => index === comment.replies!.length - 1 ? { ...item, round } : item) } : comment) }
        }
      }
      const afterSubmission = state.history.at(-1)?.id
      return { ...state, review: next, round, phase: 'awaiting-review', snapshots: [...state.snapshots, { round, openedAt: new Date().toISOString(), review: structuredClone(next), publication, ...(afterSubmission ? { afterSubmission } : {}) }] }
    }, view)
  }
  async waitForChange<V extends View = undefined>(session: string, afterVersion: number, waitMs: number, signal?: AbortSignal, view?: V): Promise<Result<V> | null> {
    await this.serial.get(session)
    const current = await this.load(session)
    if (current.version !== afterVersion) return this.output(current, view)
    return new Promise((resolve, reject) => {
      let ended = false
      const listeners = this.listeners.get(session) ?? new Set<(state: ReviewSession) => void>()
      this.listeners.set(session, listeners)
      const finish = (result: ReviewSession | null, error?: unknown) => {
        if (ended) return
        ended = true; clearTimeout(timer); listeners.delete(changed); signal?.removeEventListener('abort', aborted)
        if (!listeners.size) this.listeners.delete(session)
        if (error) reject(error); else resolve(result ? this.output(result, view) : null)
      }
      const changed = (state: ReviewSession) => { if (state.version !== afterVersion) finish(state) }
      const aborted = () => finish(null)
      const timer = setTimeout(() => finish(null), Math.max(0, Math.min(waitMs, 25000)))
      listeners.add(changed); signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted(); else void this.load(session).then(changed, error => finish(null, error))
    })
  }
}
