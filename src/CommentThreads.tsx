import { memo, useId, useMemo, useState } from 'react'
import { CheckCheck, ChevronRight, Pencil, RotateCcw } from 'lucide-react'
import { targetExists, targetLabel } from './model.ts'
import type { CurrentSession } from './session-types.ts'
import type { DiscussionEditability, ReviewChanges, ReviewComment, ReviewDocument, Target } from './types.ts'
import { graphVersionLabel } from './revisions.ts'
import { translateError, useI18n } from './i18n.ts'
import { resolvedShortcut, shortcutFromEvent } from './shortcuts.ts'
import { useShortcutSettings } from './use-shortcuts.ts'

const statusLabels = { open: '待处理', resolved: '已确认解决', 'needs-review': '待复核' }
const keyOf = (target: Target) => `${target.kind}:${target.id}`

function DiscussionBody({ body, reply = false, blocked, onSave }: {
  body: string; reply?: boolean; blocked: boolean; onSave?: (body: string, from: string) => string | null
}) {
  const { t, locale } = useI18n()
  const { bindings } = useShortcutSettings()
  const id = useId()
  const [draft, setDraft] = useState<{ body: string; from: string } | null>(null)
  const [error, setError] = useState('')
  const label = t(reply ? '编辑补充说明' : '编辑讨论内容')
  function save() {
    if (!draft || blocked || !onSave) return
    const failure = onSave(draft.body, draft.from)
    setError(failure ?? '')
    if (!failure) setDraft(null)
  }
  if (!draft) return <><p className={reply ? undefined : 'comment-body'}>{body}</p>{onSave && <button className="button subtle edit-discussion" aria-label={label}
    disabled={blocked} onClick={() => { setDraft({ body, from: body }); setError('') }}><Pencil size={13} />{t('编辑')}</button>}</>
  return <form className="discussion-edit" data-unsaved={draft.body !== body} aria-label={label} onSubmit={event => { event.preventDefault(); save() }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setDraft(null) }
    if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const binding = shortcutFromEvent(event.nativeEvent)
    if (binding && bindings.saveComment && resolvedShortcut(binding) === resolvedShortcut(bindings.saveComment)) { event.preventDefault(); save() }
  }}>
    <label htmlFor={`${id}-body`}>{label}</label>
    <textarea id={`${id}-body`} autoFocus rows={4} maxLength={10000} value={draft.body} aria-invalid={!!error}
      aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setDraft({ ...draft, body: event.target.value }); setError('') }} />
    {error && <p id={`${id}-error`} role="alert">{translateError(error, locale)}</p>}
    {!onSave && <p role="status">{t('此内容已提交或进入历史，不能修改。')}</p>}
    <div className="comment-actions"><button className="button primary" type="submit" disabled={blocked || !onSave || !draft.body.trim()}>{t('保存修改')}</button>
      <button className="button subtle" type="button" onClick={() => setDraft(null)}>{t('取消')}</button></div>
  </form>
}

interface Props {
  review: ReviewDocument
  session: CurrentSession | null
  snapshots: Map<number, ReviewDocument>
  comments: ReviewComment[]
  editableDiscussion: DiscussionEditability
  editDiscussion: (commentId: string, body: string, from: string, replyId?: string) => string | null
  idPrefix?: string
  viewRound?: number
  changes: ReviewChanges
  threadId: string | null
  continuous: boolean
  historical: boolean
  reviewBlocked: boolean
  sessionBlocked: boolean
  setThreadId: (id: string) => void
  showTargets: (targets: Target[], round?: number) => Promise<void>
  showBaseline?: (targets: Target[]) => Promise<void>
  openComposer: (targets: Target[], at?: { x: number; y: number }, replyTo?: string) => void
  openThread?: (id: string, at: { x: number; y: number }) => void
  closeComposer: (restore?: boolean) => void
  reviewNext: (id: string, resolved: boolean) => void
}

export default memo(function CommentThreads({ review, session, snapshots, comments, editableDiscussion, editDiscussion, idPrefix = 'thread', viewRound = session?.round, changes, threadId, continuous, historical, reviewBlocked, sessionBlocked, setThreadId, showTargets, showBaseline, openComposer, openThread, closeComposer, reviewNext }: Props) {
  const { t, locale } = useI18n()
  const origins = useMemo(() => new Map(session?.commentOrigins.map(item => [item.commentId, item]) ?? []), [session])
  const numbers = useMemo(() => new Map(review.comments.map((comment, index) => [comment.id, index + 1])), [review.comments])
  const editableComments = useMemo(() => new Set(editableDiscussion.comments), [editableDiscussion])
  const editableReplies = useMemo(() => new Set(editableDiscussion.replies.map(reply => JSON.stringify([reply.commentId, reply.replyId]))), [editableDiscussion])
  return <>{comments.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(comment => {
              const original = origins.get(comment.id)
              const baselineComment = comment.basis === 'baseline'
              const originalGraph = baselineComment ? review.baseline ?? review : original ? snapshots.get(original.round) ?? review : review
              const remaining = comment.targets.filter(target => targetExists(review, target)).length
              const labels = comment.targets.map(target => targetLabel(baselineComment ? originalGraph : targetExists(review, target) ? review : originalGraph, target, t)).join(' · ')
              const versionLabel = (round: number) => session?.baselineReview && round === 1 ? t('基线 B') : graphVersionLabel(session ?? {}, round)
              return <article id={`${idPrefix}-${comment.id}`} key={comment.id} className={`comment-card status-${comment.status} ${threadId === comment.id ? 'is-active' : ''}`} aria-label={t('意见 {number}', { number: numbers.get(comment.id) ?? '' })}>
              <div className="comment-card-head"><span className="status-label">#{numbers.get(comment.id)} · {t(statusLabels[comment.status])}</span>{openThread && <button className="button subtle read-discussion" aria-label={t('展开意见 {number} 的完整讨论', { number: numbers.get(comment.id) ?? '' })} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openThread(comment.id, { x: rect.left, y: rect.bottom }) }}>{t('展开讨论')}<ChevronRight size={12} /></button>}</div>
              {baselineComment && showBaseline ? <button className="jump-to-target" onClick={() => { closeComposer(false); setThreadId(comment.id); void showBaseline(comment.targets) }}>{t('基线 B · {labels}', { labels })}<ChevronRight size={12} /></button>
                : remaining || original ? <button className="jump-to-target" onClick={() => { if (!remaining) closeComposer(false); setThreadId(comment.id); showTargets(comment.targets, remaining ? session?.round : original?.round) }}>{remaining ? labels : t(original?.exact === false ? '查看原位置（推断） · {labels}' : '查看原位置 · {labels}', { labels })}<ChevronRight size={12} /></button> : <p className="comment-meta">{labels}</p>}<DiscussionBody body={comment.body} blocked={historical || sessionBlocked} onSave={!historical && editableComments.has(comment.id) ? (body, from) => editDiscussion(comment.id, body, from) : undefined} />
              {remaining < comment.targets.length && <p className="comment-location-note">{remaining ? t('当前可定位 {remaining} 项，已移除 {removed} 项。', { remaining, removed: comment.targets.length - remaining }) : t('原目标已移除，意见与原位置已保留。')}</p>}
              <details className="comment-history"><summary>{baselineComment ? t('提出于基线 B') : original ? t(original.exact ? '提出于 {version}' : '提出于 {version}（推断）', { version: versionLabel(original.round) }) : t('版本信息')}{comment.reviewedRound && <> · {t('{version} 已复核', { version: versionLabel(comment.reviewedRound) })}</>}</summary>
                <p className="comment-meta">{t('原意见版本 {revision}', { revision: comment.revision })}</p>
                <p className="comment-meta">{t('提出时间 {time}', { time: new Date(comment.createdAt).toLocaleString(locale) })}</p>
                {comment.reviewedRound && <p className="comment-meta">{t('已在 {version} 人工复核', { version: versionLabel(comment.reviewedRound) })}</p>}
                {original && remaining > 0 && original.round !== viewRound && <button className="button subtle origin-location" onClick={() => { closeComposer(false); setThreadId(comment.id); showTargets(comment.targets, original.round) }}>{t(original.exact ? '查看提出时流程' : '查看提出时流程（推断）')}</button>}
                {!original && !baselineComment && session && <p className="comment-meta">{t('旧记录未能确定提出位置，意见仍保留在列表。')}</p>}
              </details>
              {comment.status === 'needs-review' && comment.targets.some(target => changes.changed.some(item => keyOf(item) === keyOf(target))) && <p className="comment-location-note">{t('所批注的逻辑已变化，请核对新版。')}</p>}
              {!!comment.replies?.length && <div className="thread-replies">{comment.replies.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(reply => <div className="reply-card" key={reply.id}><div className="comment-meta" title={reply.revision}>{t(reply.author === 'agent' ? '代理回应' : '评审补充')} · {reply.round ? versionLabel(reply.round) : reply.revision}</div><DiscussionBody body={reply.body} reply blocked={historical || sessionBlocked} onSave={!historical && editableReplies.has(JSON.stringify([comment.id, reply.id])) ? (body, from) => editDiscussion(comment.id, body, from, reply.id) : undefined} /></div>)}</div>}
              <div className="comment-actions"><button className="button subtle" aria-label={t('回复讨论')} disabled={historical || sessionBlocked} onClick={() => openComposer(comment.targets, undefined, comment.id)}>{t('回复')}</button>{comment.status !== 'resolved' ? <button className="button subtle" aria-label={t(continuous ? '确认并看下一条' : comment.status === 'needs-review' ? '复核并确认解决' : '确认解决')} disabled={reviewBlocked} onClick={() => reviewNext(comment.id, true)}><CheckCheck size={13} />{t(continuous ? '确认并下一条' : '确认解决')}</button> : <button className="button subtle" disabled={reviewBlocked} onClick={() => reviewNext(comment.id, false)}><RotateCcw size={13} />{t('重新打开')}</button>}{comment.status === 'needs-review' && <button className="button subtle" aria-label={t(continuous ? '仍需处理并下一条' : '复核后仍需处理')} disabled={reviewBlocked} onClick={() => reviewNext(comment.id, false)}>{t(continuous ? '仍需处理并下一条' : '仍需处理')}</button>}</div>
            </article>})}</>
})
