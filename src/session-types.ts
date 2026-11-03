import type { CommentReply, CommentStatus, ReviewComment, ReviewDocument, ReviewRecord, SourceFile } from './types.ts'

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
  snapshots: ReviewSnapshot[]
  acknowledgedSubmission?: string
}

export interface SourceVerification {
  algorithm: 'sha256-path-content-v1'
  checkedAt: string
  files: SourceFile[]
  fingerprint: string
}

export interface RevisionPublication {
  baseRound: number
  summary: string
  source: SourceVerification
  unchangedReason?: string
}

export interface ReviewSnapshot {
  round: number
  openedAt: string
  review: ReviewDocument
  afterSubmission?: string
  publication?: RevisionPublication
}

export interface ReviseRequest {
  expectedVersion: number
  review: ReviewDocument
  publication: RevisionPublication
  replies?: { commentId: string; body: string }[]
}

export type ReviewMutation =
  | { kind: 'add-comment'; comment: ReviewComment }
  | { kind: 'add-reply'; commentId: string; reply: CommentReply }
  | { kind: 'set-status'; commentId: string; from: CommentStatus; status: CommentStatus; reviewedRevision: string }

export interface MutationBatch {
  round?: number
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

export type SnapshotInfo = Omit<ReviewSnapshot, 'review'>

export interface RecordInfo {
  id: string
  kind: ReviewRecord['kind']
  createdAt: string
  round: number
  revision: string
  fingerprint: string
}

export type CurrentSession = Omit<ReviewSession, 'history' | 'snapshots'> & {
  view: 'current'
  snapshots: SnapshotInfo[]
  history: RecordInfo[]
  submittedCommentIds: string[]
  commentOrigins: { commentId: string; round: number; exact: boolean }[]
}
