import type { CommentReply, CommentStatus, ReviewComment, ReviewDocument, ReviewRecord } from './types.ts'

export type SessionPhase = 'awaiting-review' | 'feedback-ready' | 'agent-working' | 'approved'

export interface ReviewSession {
  schemaVersion: 1
  id: string
  version: number
  round: number
  phase: SessionPhase
  createdAt: string
  updatedAt: string
  review: ReviewDocument
  history: ReviewRecord[]
  snapshots: { round: number; openedAt: string; review: ReviewDocument; afterSubmission?: string }[]
  acknowledgedSubmission?: string
}

export type ReviewMutation =
  | { kind: 'add-comment'; comment: ReviewComment }
  | { kind: 'add-reply'; commentId: string; reply: CommentReply }
  | { kind: 'set-status'; commentId: string; from: CommentStatus; status: CommentStatus; reviewedRevision: string }

export interface MutationBatch {
  expectedVersion?: number
  revision: string
  fingerprint: string
  mutations: ReviewMutation[]
}

export interface SessionFeedback {
  sessionId: string
  round: number
  submission: ReviewRecord
}
