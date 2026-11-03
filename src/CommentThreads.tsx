import { memo, useMemo } from 'react'
import { CheckCheck, ChevronRight, RotateCcw } from 'lucide-react'
import { targetExists, targetLabel } from './model.ts'
import type { CurrentSession } from './session-types.ts'
import type { ReviewChanges, ReviewComment, ReviewDocument, Target } from './types.ts'

const statusLabels = { open: '待处理', resolved: '已确认解决', 'needs-review': '待复核' }
const keyOf = (target: Target) => `${target.kind}:${target.id}`

interface Props {
  review: ReviewDocument
  session: CurrentSession | null
  snapshots: Map<number, ReviewDocument>
  comments: ReviewComment[]
  changes: ReviewChanges
  threadId: string | null
  continuous: boolean
  historical: boolean
  reviewBlocked: boolean
  sessionBlocked: boolean
  setThreadId: (id: string) => void
  showTargets: (targets: Target[], round?: number) => Promise<void>
  openComposer: (targets: Target[], at?: { x: number; y: number }, replyTo?: string) => void
  closeComposer: (restore?: boolean) => void
  reviewNext: (id: string, resolved: boolean) => void
}

export default memo(function CommentThreads({ review, session, snapshots, comments, changes, threadId, continuous, historical, reviewBlocked, sessionBlocked, setThreadId, showTargets, openComposer, closeComposer, reviewNext }: Props) {
  const origins = useMemo(() => new Map(session?.commentOrigins.map(item => [item.commentId, item]) ?? []), [session])
  const numbers = useMemo(() => new Map(review.comments.map((comment, index) => [comment.id, index + 1])), [review.comments])
  return <>{[...comments].reverse().map(comment => {
              const original = origins.get(comment.id)
              const originalGraph = original ? snapshots.get(original.round) ?? review : review
              const remaining = comment.targets.filter(target => targetExists(review, target)).length
              return <article id={`thread-${comment.id}`} key={comment.id} className={`comment-card status-${comment.status} ${threadId === comment.id ? 'is-active' : ''}`} aria-label={`意见 ${numbers.get(comment.id)}`}>
              <div className="comment-card-head"><span className="status-label">#{numbers.get(comment.id)} · {statusLabels[comment.status]}</span><span className="comment-meta">{new Date(comment.createdAt).toLocaleDateString('zh-CN')}</span></div>
              <button className="jump-to-target" onClick={() => { setThreadId(comment.id); showTargets(comment.targets, remaining ? session?.round : original?.round) }}>{comment.targets.map(target => targetLabel(targetExists(review, target) ? review : originalGraph, target)).join(' · ')}<ChevronRight size={12} /></button><p className="comment-body">{comment.body}</p><div className="comment-meta">原意见版本 {comment.revision}{original && ` · ${original.exact ? '提出于' : '推断位置'} R${original.round}`}{comment.reviewedRound && ` · 已在 R${comment.reviewedRound} 人工复核`}</div>
              {remaining < comment.targets.length && <p className="comment-location-note">{remaining ? `当前可定位 ${remaining} 项，已移除 ${comment.targets.length - remaining} 项` : '原目标已移除，意见与原位置已保留'}。</p>}
              {original ? <button className="button subtle origin-location" onClick={() => { closeComposer(false); setThreadId(comment.id); showTargets(comment.targets, original.round) }}>查看提出时流程{!original.exact && '（推断）'}</button> : session && <p className="comment-meta">旧记录未能确定提出位置，意见仍保留在列表。</p>}
              {comment.status === 'needs-review' && <div className="revision-banner"><p>请结合当前 {review.revision} 核对原意见{comment.targets.some(target => !targetExists(review, target)) ? '，部分原目标已移除' : ''}。{comment.targets.some(target => changes.changed.some(item => keyOf(item) === keyOf(target))) ? '所批注的逻辑已变化。' : '请查看最新回复及流程依据。'}</p></div>}
              {!!comment.replies?.length && <div className="thread-replies">{comment.replies.map(reply => <div className="reply-card" key={reply.id}><div className="comment-meta">{reply.author === 'agent' ? '代理回应' : '评审补充'} · {reply.round && `R${reply.round} · `}{reply.revision}</div><p>{reply.body}</p></div>)}</div>}
              <div className="comment-actions"><button className="button subtle" disabled={historical || sessionBlocked} onClick={() => openComposer(comment.targets, undefined, comment.id)}>回复讨论</button>{comment.status !== 'resolved' ? <button className="button subtle" disabled={reviewBlocked} onClick={() => reviewNext(comment.id, true)}><CheckCheck size={13} />{continuous ? '确认并看下一条' : comment.status === 'needs-review' ? '复核并确认解决' : '确认解决'}</button> : <button className="button subtle" disabled={reviewBlocked} onClick={() => reviewNext(comment.id, false)}><RotateCcw size={13} />重新打开</button>}{comment.status === 'needs-review' && <button className="button subtle" disabled={reviewBlocked} onClick={() => reviewNext(comment.id, false)}>{continuous ? '仍需处理并下一条' : '复核后仍需处理'}</button>}</div>
            </article>})}</>
})
