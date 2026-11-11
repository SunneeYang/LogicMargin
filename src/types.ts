export type Target = { kind: 'node' | 'edge' | 'scene' | 'review'; id: string }
export type CommentStatus = 'open' | 'resolved' | 'needs-review'

export interface Evidence {
  path: string
  symbol: string
  startLine: number
  endLine: number
  digest: string
  code?: string
}

export interface ReviewNode {
  id: string
  sceneId: string
  title: string
  kind: 'action' | 'decision' | 'result' | 'failure'
  summary: string
  detail: string
  input: string
  output: string
  position: { x: number; y: number }
  evidence: Evidence[]
}

export interface ReviewEdge {
  id: string
  sceneId: string
  source: string
  target: string
  label: string
  detail: string
}

export interface CommentReply {
  id: string
  author: 'reviewer' | 'agent'
  body: string
  createdAt: string
  revision: string
  round?: number
}

export interface ReviewComment {
  id: string
  body: string
  targets: Target[]
  status: CommentStatus
  createdAt: string
  revision: string
  reviewedRevision?: string
  originRound?: number
  reviewedRound?: number
  replies?: CommentReply[]
  basis?: 'baseline'
}

export interface DiscussionEditability {
  comments: string[]
  replies: { commentId: string; replyId: string }[]
}

export interface ReviewDocument {
  schemaVersion: 1
  id: string
  title: string
  description: string
  revision: string
  snapshot: {
    repository: string
    commit: string
    fingerprint: string
    capturedAt: string
    dirty: boolean
    files?: SourceFile[]
  }
  coverage: { included: string[]; excluded: string[]; note: string }
  scenes: { id: string; title: string; description: string }[]
  nodes: ReviewNode[]
  edges: ReviewEdge[]
  comments: ReviewComment[]
  baseline?: ReviewBaseline
}

export type ReviewBaseline = Omit<ReviewDocument, 'baseline'>

export interface SourceFile { path: string; sha256: string }

export interface ReviewChanges {
  added: Target[]
  changed: Target[]
  removed: Target[]
}

export interface CommentDraft {
  key: string
  documentId: string
  revision: string
  fingerprint: string
  targets: Target[]
  labels: string[]
  body: string
  updatedAt: string
  replyTo?: string
  basis?: 'baseline'
}

export interface ReviewRecord {
  schemaVersion: 1
  kind: 'logic-margin-feedback' | 'logic-margin-approval'
  id: string
  createdAt: string
  review: ReviewDocument
}
