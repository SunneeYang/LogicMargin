import { commentOrigin, submissionRound } from '../src/revisions.ts'
import { pendingFeedback } from '../src/workspace.ts'
import type { CurrentSession, ReviewSession } from '../src/session-types.ts'

export function currentSession(session: ReviewSession): CurrentSession {
  const pending = new Set(pendingFeedback({ ...session.review, comments: session.review.comments.map(comment => ({ ...comment, status: 'open' })) }, session.history).map(comment => comment.id))
  const { history, snapshots, ...current } = session
  return { ...current, view: 'current',
    snapshots: snapshots.map(({ review: _review, ...info }) => info),
    history: history.map(record => ({ id: record.id, kind: record.kind, createdAt: record.createdAt, round: submissionRound(session, record.id) ?? 1,
      revision: record.review.revision, fingerprint: record.review.snapshot.fingerprint })),
    submittedCommentIds: session.review.comments.filter(comment => !pending.has(comment.id)).map(comment => comment.id),
    commentOrigins: session.review.comments.flatMap(comment => {
      const origin = commentOrigin(session, comment)
      return origin ? [{ commentId: comment.id, ...origin }] : []
    }),
  }
}
