import { memo, useMemo } from 'react'
import { CheckCheck, ChevronRight, RotateCcw } from 'lucide-react'
import { targetExists, targetLabel } from './model.ts'
import type { CurrentSession } from './session-types.ts'
import type { ReviewChanges, ReviewComment, ReviewDocument, Target } from './types.ts'
import { graphVersionLabel } from './revisions.ts'

const statusLabels = { open: '待处理', resolved: '已确认解决', 'needs-review': '待复核' }
const keyOf = (target: Target) => `${target.kind}:${target.id}`

interface Props {
  review: ReviewDocument
  session: CurrentSession | null
  snapshots: Map<number, ReviewDocument>
  comments: ReviewComment[]
  chronological?: boolean
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

export default memo(function CommentThreads({ review, session, snapshots, comments, idPrefix = 'thread', chronological = false, viewRound = session?.round, changes, threadId, continuous, historical, reviewBlocked, sessionBlocked, setThreadId, showTargets, showBaseline, openComposer, openThread, closeComposer, reviewNext }: Props) {
  const origins = useMemo(() => new Map(session?.commentOrigins.map(item => [item.commentId, item]) ?? []), [session])
  const numbers = useMemo(() => new Map(review.comments.map((comment, index) => [comment.id, index + 1])), [review.comments])
  return <>{(chronological ? comments : [...comments].reverse()).map(comment => {
              const original = origins.get(comment.id)
              const baselineComment = comment.basis === 'baseline'
              const originalGraph = baselineComment ? review.baseline ?? review : original ? snapshots.get(original.round) ?? review : review
              const remaining = comment.targets.filter(target => targetExists(review, target)).length
              const labels = comment.targets.map(target => targetLabel(baselineComment ? originalGraph : targetExists(review, target) ? review : originalGraph, target)).join(' · ')
              const versionLabel = (round: number) => graphVersionLabel(session ?? {}, round)
              return <article id={`${idPrefix}-${comment.id}`} key={comment.id} className={`comment-card status-${comment.status} ${threadId === comment.id ? 'is-active' : ''}`} aria-label={`意见 ${numbers.get(comment.id)}`}>
              <div className="comment-card-head"><span className="status-label">#{numbers.get(comment.id)} · {statusLabels[comment.status]}</span>{openThread && <button className="button subtle read-discussion" aria-label={`展开意见 ${numbers.get(comment.id)} 的完整讨论`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openThread(comment.id, { x: rect.left, y: rect.bottom }) }}>展开讨论<ChevronRight size={12} /></button>}</div>
              {baselineComment && showBaseline ? <button className="jump-to-target" onClick={() => { closeComposer(false); setThreadId(comment.id); void showBaseline(comment.targets) }}>基线 B · {labels}<ChevronRight size={12} /></button>
                : remaining || original ? <button className="jump-to-target" onClick={() => { if (!remaining) closeComposer(false); setThreadId(comment.id); showTargets(comment.targets, remaining ? session?.round : original?.round) }}>{!remaining && `查看原位置${original?.exact === false ? '（推断）' : ''} · `}{labels}<ChevronRight size={12} /></button> : <p className="comment-meta">{labels}</p>}<p className="comment-body">{comment.body}</p>
              {remaining < comment.targets.length && <p className="comment-location-note">{remaining ? `当前可定位 ${remaining} 项，已移除 ${comment.targets.length - remaining} 项` : '原目标已移除，意见与原位置已保留'}。</p>}
              <details className="comment-history"><summary>{baselineComment ? '提出于基线 B' : original ? `提出于 ${versionLabel(original.round)}${!original.exact ? '（推断）' : ''}` : '版本信息'}{comment.reviewedRound && ` · ${versionLabel(comment.reviewedRound)} 已复核`}</summary>
                <p className="comment-meta">原意见版本 {comment.revision}</p>
                <p className="comment-meta">提出时间 {new Date(comment.createdAt).toLocaleString('zh-CN')}</p>
                {comment.reviewedRound && <p className="comment-meta">已在 {versionLabel(comment.reviewedRound)} 人工复核</p>}
                {original && remaining > 0 && original.round !== viewRound && <button className="button subtle origin-location" onClick={() => { closeComposer(false); setThreadId(comment.id); showTargets(comment.targets, original.round) }}>查看提出时流程{!original.exact && '（推断）'}</button>}
                {!original && !baselineComment && session && <p className="comment-meta">旧记录未能确定提出位置，意见仍保留在列表。</p>}
              </details>
              {comment.status === 'needs-review' && comment.targets.some(target => changes.changed.some(item => keyOf(item) === keyOf(target))) && <p className="comment-location-note">所批注的逻辑已变化，请核对新版。</p>}
              {!!comment.replies?.length && <div className="thread-replies">{comment.replies.map(reply => <div className="reply-card" key={reply.id}><div className="comment-meta" title={reply.revision}>{reply.author === 'agent' ? '代理回应' : '评审补充'} · {reply.round ? versionLabel(reply.round) : reply.revision}</div><p>{reply.body}</p></div>)}</div>}
              <div className="comment-actions"><button className="button subtle" aria-label="回复讨论" disabled={historical || sessionBlocked} onClick={() => openComposer(comment.targets, undefined, comment.id)}>回复</button>{comment.status !== 'resolved' ? <button className="button subtle" aria-label={continuous ? '确认并看下一条' : comment.status === 'needs-review' ? '复核并确认解决' : '确认解决'} disabled={reviewBlocked} onClick={() => reviewNext(comment.id, true)}><CheckCheck size={13} />{continuous ? '确认并下一条' : '确认解决'}</button> : <button className="button subtle" disabled={reviewBlocked} onClick={() => reviewNext(comment.id, false)}><RotateCcw size={13} />重新打开</button>}{comment.status === 'needs-review' && <button className="button subtle" aria-label={continuous ? '仍需处理并下一条' : '复核后仍需处理'} disabled={reviewBlocked} onClick={() => reviewNext(comment.id, false)}>{continuous ? '仍需处理并下一条' : '仍需处理'}</button>}</div>
            </article>})}</>
})
