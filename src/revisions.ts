import { parseSourceFiles, targetExists } from './model.ts'
import type { ReviewChanges, ReviewComment, ReviewDocument, ReviewEdge, ReviewNode, Target } from './types.ts'
import type { RevisionPublication, ReviewSession, ReviewSnapshot } from './session-types.ts'

export interface RevisionChanges extends ReviewChanges { evidenceChanged: Target[]; metadataChanged: boolean }

export function graphVersionLabel(session: { baselineReview?: true }, round: number): string {
  if (session.baselineReview && round === 1) return '基线 B'
  return `R${session.baselineReview ? round - 1 : round}`
}

const nodeLogic = (node: ReviewNode) => [node.sceneId, node.title, node.kind, node.summary, node.detail, node.input, node.output]
const edgeLogic = (edge: ReviewEdge) => [edge.sceneId, edge.source, edge.target, edge.label, edge.detail]
const metadata = (review: ReviewDocument) => [review.title, review.description, review.coverage, review.scenes.map(scene => [scene.id, scene.title, scene.description]).sort()]
const key = (target: Target) => `${target.kind}:${target.id}`

export function logicIdentity(review: ReviewDocument): string {
  return JSON.stringify([metadata(review), review.nodes.map(node => [node.id, nodeLogic(node)]).sort(), review.edges.map(edge => [edge.id, edgeLogic(edge)]).sort()])
}

export function getRevisionChanges(before: ReviewDocument, after: ReviewDocument): RevisionChanges {
  const elements = (review: ReviewDocument) => [
    ...review.nodes.map(node => ({ target: { kind: 'node', id: node.id } as Target, logic: nodeLogic(node),
      evidence: node.evidence.map(({ path, symbol, startLine, endLine, digest }) => [path, symbol, startLine, endLine, digest]) })),
    ...review.edges.map(edge => ({ target: { kind: 'edge', id: edge.id } as Target, logic: edgeLogic(edge), evidence: [] })),
  ]
  const previous = new Map(elements(before).map(item => [key(item.target), item]))
  const current = new Map(elements(after).map(item => [key(item.target), item]))
  return {
    added: [...current].filter(([id]) => !previous.has(id)).map(([, item]) => item.target),
    changed: [...current].filter(([id, item]) => previous.has(id) && JSON.stringify(previous.get(id)!.logic) !== JSON.stringify(item.logic)).map(([, item]) => item.target),
    removed: [...previous].filter(([id]) => !current.has(id)).map(([, item]) => item.target),
    evidenceChanged: [...current].filter(([id, item]) => previous.has(id) && JSON.stringify(previous.get(id)!.evidence) !== JSON.stringify(item.evidence)).map(([, item]) => item.target),
    metadataChanged: JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after)),
  }
}

export function parsePublication(value: unknown): RevisionPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('新版发布缺少来源核验和变更说明')
  const publication = value as Record<string, unknown>
  const source = publication.source as Record<string, unknown> | undefined
  if (!Number.isSafeInteger(publication.baseRound) || Number(publication.baseRound) < 1 ||
    typeof publication.summary !== 'string' || !publication.summary.trim() || publication.summary.length > 10000 ||
    !source || typeof source !== 'object' || Array.isArray(source) || source.algorithm !== 'sha256-path-content-v1' ||
    typeof source.checkedAt !== 'string' || !Number.isFinite(Date.parse(source.checkedAt)) ||
    typeof source.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint)) throw new Error('新版发布的轮次、说明或来源核验无效')
  if (publication.unchangedReason !== undefined && (typeof publication.unchangedReason !== 'string' || !publication.unchangedReason.trim() || publication.unchangedReason.length > 10000)) throw new Error('流程未变时需要明确说明原因')
  return {
    baseRound: Number(publication.baseRound), summary: publication.summary.trim(),
    source: { algorithm: 'sha256-path-content-v1', checkedAt: source.checkedAt, fingerprint: source.fingerprint, files: parseSourceFiles(source.files) },
    ...(publication.unchangedReason === undefined ? {} : { unchangedReason: (publication.unchangedReason as string).trim() }),
  }
}

export function submissionRound(session: ReviewSession, submissionId: string): number | undefined {
  const index = session.history.findIndex(record => record.id === submissionId)
  if (index < 0) return undefined
  return [...session.snapshots].reverse().find(snapshot => index > (snapshot.afterSubmission === undefined ? -1 : session.history.findIndex(record => record.id === snapshot.afterSubmission)))?.round
}

export function commentOrigin(session: ReviewSession, comment: ReviewComment): { round: number; exact: boolean } | undefined {
  if (comment.basis === 'baseline') return undefined
  if (comment.originRound !== undefined) return session.snapshots.some(snapshot => snapshot.round === comment.originRound) ? { round: comment.originRound, exact: true } : undefined
  const submitted = session.history.find(record => record.review.comments.some(item => item.id === comment.id))
  if (submitted) {
    const round = submissionRound(session, submitted.id)
    if (round !== undefined) return { round, exact: false }
  }
  const matching = session.snapshots.filter(snapshot => snapshot.review.revision === comment.revision && comment.targets.some(target => targetExists(snapshot.review, target)))
  const atCreation = matching.filter(snapshot => Date.parse(snapshot.openedAt) <= Date.parse(comment.createdAt)).at(-1)
  const snapshot = atCreation ?? matching[0] ?? session.snapshots.find(snapshot => snapshot.review.comments.some(item => item.id === comment.id))
  return snapshot ? { round: snapshot.round, exact: false } : undefined
}

export function reviewAtRound(session: ReviewSession, round: number): ReviewDocument {
  const snapshot = session.snapshots.find(snapshot => snapshot.round === round)
  if (!snapshot) throw new Error('找不到这个流程版本')
  if (round === session.round) return session.review
  return { ...snapshot.review, ...(session.review.baseline ? { baseline: session.review.baseline } : {}), comments: session.review.comments.filter(comment => {
    if (comment.basis === 'baseline') return (comment.originRound ?? 1) <= round && !!session.review.baseline && comment.targets.some(target => targetExists(session.review.baseline!, target))
    const origin = commentOrigin(session, comment)
    return origin !== undefined && origin.round <= round && comment.targets.some(target => targetExists(snapshot.review, target))
  }) }
}

export function comparisonSnapshot(session: ReviewSession): ReviewSnapshot | undefined {
  const current = session.snapshots.find(snapshot => snapshot.round === session.round)
  const round = current?.publication?.baseRound ?? session.round - 1
  return session.snapshots.find(snapshot => snapshot.round === round)
}
