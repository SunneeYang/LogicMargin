import { parseReview, targetLabel } from './model.ts'
import { newId } from './id.ts'
import type { CommentDraft, DiscussionEditability, ReviewComment, ReviewDocument, ReviewRecord, Target } from './types.ts'

export type { CommentDraft, ReviewRecord } from './types.ts'

export function editableLocalDiscussion(review: ReviewDocument, history: ReviewRecord[]): DiscussionEditability {
  const submitted = history.filter(record => record.review.id === review.id).flatMap(record => record.review.comments)
  const comments = new Set(submitted.map(comment => comment.id))
  const replies = new Set(submitted.flatMap(comment => (comment.replies ?? []).map(reply => JSON.stringify([comment.id, reply.id]))))
  return {
    comments: review.comments.filter(comment => comment.revision === review.revision && !comments.has(comment.id)).map(comment => comment.id),
    replies: review.comments.flatMap(comment => (comment.replies ?? []).filter(reply => reply.author === 'reviewer' && reply.revision === review.revision
      && !replies.has(JSON.stringify([comment.id, reply.id]))).map(reply => ({ commentId: comment.id, replyId: reply.id }))),
  }
}

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

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  return value
}

function targets(value: unknown): Target[] {
  const result = list(value, '草稿目标').map(value => {
    const target = object(value, '草稿目标')
    if (typeof target.kind !== 'string' || !['node', 'edge', 'scene', 'review'].includes(target.kind)) throw new Error('草稿目标类型无效')
    return { kind: target.kind as Target['kind'], id: id(target.id, '草稿目标 ID') }
  })
  if (!result.length || new Set(result.map(target => JSON.stringify([target.kind, target.id]))).size !== result.length) {
    throw new Error('草稿至少需要一个目标，且目标不能重复')
  }
  return result
}

function key(documentId: string, revision: string, fingerprint: string, selected: Target[], replyTo?: string, basis?: CommentDraft['basis']): string {
  const parts = [documentId, revision, fingerprint, selected.map(target => [target.kind, target.id]).sort(), replyTo ?? null]
  return JSON.stringify(basis ? [...parts, basis] : parts)
}

function draftBasis(review: ReviewDocument, replyTo?: string, basis?: CommentDraft['basis']): CommentDraft['basis'] {
  const original = review.comments.find(comment => comment.id === replyTo)
  if (basis !== undefined && basis !== 'baseline') throw new Error('草稿依据无效')
  if (original && basis !== undefined && original.basis !== basis) throw new Error('回复草稿不能改变原批注依据')
  return original?.basis ?? basis
}

export function draftKey(review: ReviewDocument, selected: Target[], replyTo?: string, basis?: CommentDraft['basis']): string {
  return key(id(review.id, '评审 ID'), id(review.revision, '评审版本'), id(review.snapshot.fingerprint, '快照指纹'),
    targets(selected), replyTo === undefined ? undefined : id(replyTo, '回复批注 ID'), draftBasis(review, replyTo, basis))
}

export function makeDraft(review: ReviewDocument, selected: Target[], body: string, replyTo?: string, basis?: CommentDraft['basis']): CommentDraft {
  const checked = targets(selected)
  const selectedBasis = draftBasis(review, replyTo, basis)
  const document = selectedBasis === 'baseline' ? review.baseline : review
  if (!document) throw new Error('请先加载固定基线 B 再编写批注')
  return { key: draftKey(review, checked, replyTo, selectedBasis), documentId: review.id, revision: review.revision,
    fingerprint: review.snapshot.fingerprint, targets: checked, labels: checked.map(target => targetLabel(document, target)),
    body: text(body, '草稿内容', 10000), updatedAt: new Date().toISOString(), ...(replyTo === undefined ? {} : { replyTo }),
    ...(selectedBasis ? { basis: selectedBasis } : {}) }
}

export function parseDrafts(value: unknown): CommentDraft[] {
  const parsed = list(value, '批注草稿').map((value): CommentDraft => {
    const draft = object(value, '批注草稿')
    const selected = targets(draft.targets)
    const documentId = id(draft.documentId, '草稿评审 ID')
    const revision = id(draft.revision, '草稿版本')
    const fingerprint = id(draft.fingerprint, '草稿快照指纹')
    const replyTo = draft.replyTo === undefined ? undefined : id(draft.replyTo, '回复批注 ID')
    if (draft.basis !== undefined && draft.basis !== 'baseline') throw new Error('草稿依据无效')
    const basis = draft.basis
    const labels = list(draft.labels, '草稿目标标签').map(value => text(value, '草稿目标标签', 2000, true))
    if (labels.length !== selected.length) throw new Error('草稿目标与标签数量不一致')
    const expectedKey = key(documentId, revision, fingerprint, selected, replyTo, basis)
    if (draft.key !== expectedKey) throw new Error('草稿标识与所属评审、版本或目标不一致')
    return { key: expectedKey, documentId, revision, fingerprint, targets: selected, labels,
      body: text(draft.body, '草稿内容', 10000), updatedAt: date(draft.updatedAt, '草稿保存日期'),
      ...(replyTo === undefined ? {} : { replyTo }), ...(basis ? { basis } : {}) }
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
  return result
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
  return result
}

export function parseRecordHistory(value: unknown): ReviewRecord[] {
  if (!Array.isArray(value)) throw new Error('评审历史必须是数组')
  const byId = new Map<string, ReviewRecord>()
  for (const source of value) {
    const item = parseReviewRecord(source)
    const existing = byId.get(item.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error(`评审记录 ${item.id} 的内容冲突`)
    byId.set(item.id, item)
  }
  return [...byId.values()]
}

export function humanFeedback(comment: ReviewComment): string {
  return JSON.stringify([comment.body, comment.basis ?? null, comment.targets.map(target => [target.kind, target.id]).sort(),
    (comment.replies ?? []).filter(reply => reply.author === 'reviewer')
      .map(reply => [reply.id, reply.body, reply.createdAt, reply.revision]).sort()])
}

export function pendingFeedback(review: ReviewDocument, history: ReviewRecord[]): ReviewComment[] {
  const latestByComment = new Map<string, { record: ReviewRecord; comment: ReviewComment; time: number }>()
  for (const record of history) {
    if (record.kind !== 'logic-margin-feedback' || record.review.id !== review.id) continue
    const time = Date.parse(record.createdAt)
    for (const comment of record.review.comments) {
      if (time >= (latestByComment.get(comment.id)?.time ?? -Infinity)) latestByComment.set(comment.id, { record, comment, time })
    }
  }
  return review.comments.filter(comment => {
    if (comment.status !== 'open') return false
    const submitted = latestByComment.get(comment.id)
    return !submitted || submitted.record.review.revision !== review.revision ||
      submitted.record.review.snapshot.fingerprint !== review.snapshot.fingerprint || humanFeedback(submitted.comment) !== humanFeedback(comment)
  })
}
