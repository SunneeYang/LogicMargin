import { parseReview, targetLabel } from './model.ts'
import { newId } from './id.ts'
import type { CommentDraft, ReviewComment, ReviewDocument, ReviewRecord, Target } from './types.ts'

export type { CommentDraft, ReviewRecord } from './types.ts'

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label}无效，最多 ${max} 字符`)
  return value
}

const id = (value: unknown, label: string) => text(value, label, 200, true)

function date(value: unknown, label: string): string {
  const result = text(value, label, 100, true)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label}必须是有效日期`)
  return result
}

function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}必须是数组，最多 ${max} 项`)
  return value
}

function targets(value: unknown): Target[] {
  const result = list(value, '草稿目标', 500).map(value => {
    const target = object(value, '草稿目标')
    if (typeof target.kind !== 'string' || !['node', 'edge', 'scene', 'review'].includes(target.kind)) throw new Error('草稿目标类型无效')
    return { kind: target.kind as Target['kind'], id: id(target.id, '草稿目标 ID') }
  })
  if (!result.length || new Set(result.map(target => JSON.stringify([target.kind, target.id]))).size !== result.length) {
    throw new Error('草稿至少需要一个目标，且目标不能重复')
  }
  return result
}

function key(documentId: string, revision: string, fingerprint: string, selected: Target[], replyTo?: string): string {
  return JSON.stringify([documentId, revision, fingerprint, selected.map(target => [target.kind, target.id]).sort(), replyTo ?? null])
}

export function draftKey(review: ReviewDocument, selected: Target[], replyTo?: string): string {
  return key(id(review.id, '评审 ID'), id(review.revision, '评审版本'), id(review.snapshot.fingerprint, '快照指纹'),
    targets(selected), replyTo === undefined ? undefined : id(replyTo, '回复批注 ID'))
}

export function makeDraft(review: ReviewDocument, selected: Target[], body: string, replyTo?: string): CommentDraft {
  const checked = targets(selected)
  return { key: draftKey(review, checked, replyTo), documentId: review.id, revision: review.revision,
    fingerprint: review.snapshot.fingerprint, targets: checked, labels: checked.map(target => targetLabel(review, target)),
    body: text(body, '草稿内容', 10000), updatedAt: new Date().toISOString(), ...(replyTo === undefined ? {} : { replyTo }) }
}

export function parseDrafts(value: unknown): CommentDraft[] {
  const parsed = list(value, '批注草稿', 200).map(value => {
    const draft = object(value, '批注草稿')
    const selected = targets(draft.targets)
    const documentId = id(draft.documentId, '草稿评审 ID')
    const revision = id(draft.revision, '草稿版本')
    const fingerprint = id(draft.fingerprint, '草稿快照指纹')
    const replyTo = draft.replyTo === undefined ? undefined : id(draft.replyTo, '回复批注 ID')
    const labels = list(draft.labels, '草稿目标标签', 500).map(value => text(value, '草稿目标标签', 2000, true))
    if (labels.length !== selected.length) throw new Error('草稿目标与标签数量不一致')
    const expectedKey = key(documentId, revision, fingerprint, selected, replyTo)
    if (draft.key !== expectedKey) throw new Error('草稿标识与所属评审、版本或目标不一致')
    return { key: expectedKey, documentId, revision, fingerprint, targets: selected, labels,
      body: text(draft.body, '草稿内容', 10000), updatedAt: date(draft.updatedAt, '草稿保存日期'),
      ...(replyTo === undefined ? {} : { replyTo }) }
  })
  if (new Set(parsed.map(draft => draft.key)).size !== parsed.length) throw new Error('草稿标识重复')
  return parsed
}

export function withDraft(drafts: CommentDraft[], draft: CommentDraft): CommentDraft[] {
  const checked = parseDrafts(drafts)
  const replacement = parseDrafts([draft])[0]
  const without = checked.filter(item => item.key !== replacement.key)
  if (replacement.body === '') return without
  const index = checked.findIndex(item => item.key === replacement.key)
  if (index >= 0) return checked.map((item, at) => at === index ? replacement : item)
  if (checked.length >= 200) throw new Error('草稿已达 200 条上限，请先处理已有草稿')
  return [...checked, replacement]
}

function record(review: ReviewDocument, kind: ReviewRecord['kind']): ReviewRecord {
  const cloned = parseReview(review)
  if (kind === 'logic-margin-feedback') {
    cloned.comments = cloned.comments.filter(comment => comment.status === 'open')
    if (!cloned.comments.length) throw new Error('没有可提交的待处理批注')
  } else if (cloned.comments.some(comment => comment.status !== 'resolved')) {
    throw new Error('仍有待处理或待复核批注，不能确认通过')
  }
  const result: ReviewRecord = { schemaVersion: 1, kind, id: newId(), createdAt: new Date().toISOString(), review: cloned }
  checkRecordSize(result)
  return result
}

function checkRecordSize(record: ReviewRecord) {
  if (new TextEncoder().encode(JSON.stringify(record, null, 2)).byteLength > 10 * 1024 * 1024) {
    throw new Error('评审记录超过 10 MB，请拆分评审后生成记录')
  }
}

export function createFeedbackPackage(review: ReviewDocument): ReviewRecord {
  return record(review, 'logic-margin-feedback')
}

export function createApprovalRecord(review: ReviewDocument): ReviewRecord {
  return record(review, 'logic-margin-approval')
}

export function parseReviewRecord(value: unknown): ReviewRecord {
  const source = object(value, '评审记录')
  if (source.schemaVersion !== 1) throw new Error('不支持此评审记录版本')
  if (source.kind !== 'logic-margin-feedback' && source.kind !== 'logic-margin-approval') throw new Error('评审记录类型无效')
  const review = parseReview(source.review)
  if (source.kind === 'logic-margin-feedback' && (!review.comments.length || review.comments.some(comment => comment.status !== 'open'))) {
    throw new Error('意见包只能包含待处理批注，且至少需要一条')
  }
  if (source.kind === 'logic-margin-approval' && review.comments.some(comment => comment.status !== 'resolved')) {
    throw new Error('通过记录不能包含未解决的批注')
  }
  const result: ReviewRecord = { schemaVersion: 1, kind: source.kind, id: id(source.id, '评审记录 ID'), createdAt: date(source.createdAt, '评审记录日期'), review }
  checkRecordSize(result)
  return result
}

export function parseRecordHistory(value: unknown): ReviewRecord[] {
  if (!Array.isArray(value)) throw new Error('评审历史必须是数组，最多 50 项')
  const byId = new Map<string, ReviewRecord>()
  for (const source of value) {
    const item = parseReviewRecord(source)
    const existing = byId.get(item.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error(`评审记录 ${item.id} 的内容冲突`)
    byId.set(item.id, item)
    if (byId.size > 50) throw new Error('评审历史最多 50 项，请先备份并归档历史')
  }
  return [...byId.values()]
}

function humanFeedback(comment: ReviewComment): string {
  return JSON.stringify([comment.body, comment.targets.map(target => [target.kind, target.id]).sort(),
    (comment.replies ?? []).filter(reply => reply.author === 'reviewer')
      .map(reply => [reply.id, reply.body, reply.createdAt, reply.revision]).sort()])
}

export function pendingFeedback(review: ReviewDocument, history: ReviewRecord[]): ReviewComment[] {
  return review.comments.filter(comment => {
    if (comment.status !== 'open') return false
    let latest: ReviewRecord | undefined
    let submitted: ReviewComment | undefined
    for (const item of history) {
      if (item.kind !== 'logic-margin-feedback' || item.review.id !== review.id) continue
      const match = item.review.comments.find(candidate => candidate.id === comment.id)
      if (match && (!latest || Date.parse(item.createdAt) >= Date.parse(latest.createdAt))) {
        latest = item
        submitted = match
      }
    }
    return !latest || !submitted || latest.review.revision !== review.revision ||
      latest.review.snapshot.fingerprint !== review.snapshot.fingerprint || humanFeedback(submitted) !== humanFeedback(comment)
  })
}
