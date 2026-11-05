import type { CommentReply, CommentStatus, ReviewBaseline, ReviewChanges, ReviewComment, ReviewDocument, ReviewEdge, ReviewNode, Target } from './types.ts'
import { newId } from './id.ts'

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 2000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`${label}必须是${required ? '非空' : ''}文本，最多 ${max} 字符`)
  }
  return value
}

const id = (value: unknown, label: string) => text(value, label, 200, true)

export function serializeReview(review: ReviewDocument): string {
  return JSON.stringify(review, null, 2)
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  return value
}

function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`${label}无效`)
  return value as T
}

function date(value: unknown, label: string): string {
  const result = text(value, label, 100, true)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label}必须是有效日期`)
  return result
}

function number(value: unknown, label: string, positiveInteger = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7 ||
    (positiveInteger && (!Number.isInteger(value) || value < 1))) throw new Error(`${label}无效`)
  return value
}

function unique<T extends { id: string }>(values: T[], label: string): T[] {
  if (new Set(values.map(item => item.id)).size !== values.length) throw new Error(`${label}的 ID 重复`)
  return values
}

function round(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数`)
  return value
}

function targets(value: unknown): Target[] {
  const result = list(value, '批注目标').map(value => {
    const target = object(value, '批注目标')
    return { kind: choice(target.kind, ['node', 'edge', 'scene', 'review'] as const, '批注目标类型'), id: id(target.id, '批注目标 ID') }
  })
  if (!result.length) throw new Error('批注至少需要一个目标')
  if (new Set(result.map(targetKey)).size !== result.length) throw new Error('批注目标重复')
  return result
}

function replies(value: unknown): CommentReply[] {
  return unique(list(value, '批注回复').map(value => {
    const reply = object(value, '批注回复')
    return { id: id(reply.id, '回复 ID'), author: choice(reply.author, ['reviewer', 'agent'] as const, '回复作者'),
      body: text(reply.body, '回复内容', 10000, true), createdAt: date(reply.createdAt, '回复日期'), revision: id(reply.revision, '回复版本'),
      ...(reply.round === undefined ? {} : { round: round(reply.round, '回复轮次') }) }
  }), '批注回复')
}

export function parseReview(value: unknown, options: { allowBaselineReferences?: boolean } = {}): ReviewDocument {
  const review = object(value, '评审文件')
  if (review.schemaVersion !== 1) throw new Error('不支持此评审文件版本；目前只支持 schemaVersion: 1')
  const snapshot = object(review.snapshot, '代码快照')
  if (typeof snapshot.dirty !== 'boolean') throw new Error('代码快照 dirty 必须是布尔值')
  const coverage = object(review.coverage, '覆盖范围')
  const scenes = unique(list(review.scenes, '场景').map(value => {
    const scene = object(value, '场景')
    return { id: id(scene.id, '场景 ID'), title: text(scene.title, '场景标题', 200, true), description: text(scene.description, '场景说明') }
  }), '场景')
  if (!scenes.length) throw new Error('评审文件至少需要一个场景')
  const sceneIds = new Set(scenes.map(scene => scene.id))
  const nodes = unique(list(review.nodes, '节点').map(value => {
    const node = object(value, '节点')
    const position = object(node.position, '节点坐标')
    const sceneId = id(node.sceneId, '节点所属场景')
    if (!sceneIds.has(sceneId)) throw new Error('节点引用了不存在的场景')
    return {
      id: id(node.id, '节点 ID'), sceneId, title: text(node.title, '节点标题', 200, true),
      kind: choice(node.kind, ['action', 'decision', 'result', 'failure'] as const, '节点类型'),
      summary: text(node.summary, '节点摘要'), detail: text(node.detail, '节点详情', 10000),
      input: text(node.input, '节点输入', 10000), output: text(node.output, '节点输出', 10000),
      position: { x: number(position.x, '节点横坐标'), y: number(position.y, '节点纵坐标') },
      evidence: list(node.evidence, '源码依据').map(value => {
        const evidence = object(value, '源码依据')
        const startLine = number(evidence.startLine, '源码起始行', true)
        const endLine = number(evidence.endLine, '源码结束行', true)
        if (endLine < startLine) throw new Error('源码结束行不能早于起始行')
        return { path: text(evidence.path, '源码路径', 2000, true), symbol: text(evidence.symbol, '源码符号', 500, true), startLine, endLine, digest: text(evidence.digest, '源码摘要', 200, true) }
      }),
    }
  }), '节点')
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const edges = unique(list(review.edges, '连线').map(value => {
    const edge = object(value, '连线')
    const sceneId = id(edge.sceneId, '连线所属场景')
    const source = id(edge.source, '连线起点')
    const target = id(edge.target, '连线终点')
    if (!sceneIds.has(sceneId) || nodeMap.get(source)?.sceneId !== sceneId || nodeMap.get(target)?.sceneId !== sceneId) {
      throw new Error('连线必须连接同一场景内的现有节点')
    }
    return { id: id(edge.id, '连线 ID'), sceneId, source, target, label: text(edge.label, '连线标签', 200), detail: text(edge.detail, '连线说明', 10000) }
  }), '连线')
  const comments = unique(list(review.comments, '批注').map(value => {
    const comment = object(value, '批注')
    return { id: id(comment.id, '批注 ID'), body: text(comment.body, '批注内容', 10000, true), targets: targets(comment.targets),
      status: choice(comment.status, ['open', 'resolved', 'needs-review'] as const, '批注状态'),
      createdAt: date(comment.createdAt, '批注日期'), revision: id(comment.revision, '批注版本'),
      ...(comment.reviewedRevision === undefined ? {} : { reviewedRevision: id(comment.reviewedRevision, '人工复核版本') }),
      ...(comment.originRound === undefined ? {} : { originRound: round(comment.originRound, '提出轮次') }),
      ...(comment.reviewedRound === undefined ? {} : { reviewedRound: round(comment.reviewedRound, '复核轮次') }),
      ...(comment.basis === undefined ? {} : { basis: choice(comment.basis, ['baseline'] as const, '批注依据') }),
      ...(comment.replies === undefined ? {} : { replies: replies(comment.replies) }) }
  }), '批注')
  const revision = id(review.revision, '评审版本')
  const result: ReviewDocument = {
    schemaVersion: 1, id: id(review.id, '评审 ID'), title: text(review.title, '评审标题', 200, true),
    description: text(review.description, '评审说明', 10000), revision,
    snapshot: { repository: text(snapshot.repository, '仓库路径', 2000, true), commit: text(snapshot.commit, '代码提交', 200, true),
      fingerprint: text(snapshot.fingerprint, '快照指纹', 200, true), capturedAt: date(snapshot.capturedAt, '快照日期'), dirty: snapshot.dirty,
      ...(snapshot.files === undefined ? {} : { files: parseSourceFiles(snapshot.files) }) },
    coverage: { included: list(coverage.included, '已覆盖范围').map(value => text(value, '已覆盖说明')),
      excluded: list(coverage.excluded, '未覆盖范围').map(value => text(value, '未覆盖说明')), note: text(coverage.note, '覆盖范围说明', 10000) },
    scenes, nodes, edges, comments,
  }
  if (review.baseline !== undefined) result.baseline = parseReviewBaseline(review.baseline, result.id)
  result.comments = comments.map(comment => {
    const document = comment.basis === 'baseline' ? result.baseline : result
    if (comment.basis === 'baseline' && (!document && !options.allowBaselineReferences || document && comment.targets.some(target => !targetExists(document, target)))) {
      throw new Error('基线批注必须引用固定基线 B 的现有目标')
    }
    return { ...comment,
      status: (comment.reviewedRevision ?? comment.revision) !== revision || (document && comment.status !== 'resolved' && comment.targets.some(target => !targetExists(document, target)))
        ? 'needs-review' : comment.status,
    }
  })
  return result
}

export function parseReviewBaseline(value: unknown, reviewId?: string): ReviewBaseline {
  const source = object(value, '固定基线')
  if (source.baseline !== undefined) throw new Error('固定基线不能嵌套另一份基线')
  const baseline = parseReview(source)
  if (reviewId !== undefined && baseline.id !== reviewId) throw new Error('固定基线必须属于相同评审 ID')
  if (baseline.comments.length) throw new Error('固定基线不能包含批注')
  return baseline
}

export function parseSourceFiles(value: unknown) {
  const files = list(value, '来源文件清单').map(value => {
    const file = object(value, '来源文件')
    const path = text(file.path, '来源路径', 2000, true)
    if (path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(path)) throw new Error('来源路径必须是工作区内的规范相对路径')
    const sha256 = text(file.sha256, '来源文件摘要', 64, true)
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('来源摘要必须是 SHA-256')
    return { path, sha256 }
  })
  if (!files.length || new Set(files.map(file => file.path)).size !== files.length) throw new Error('来源文件清单不能为空或包含重复路径')
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

const targetKey = (target: Target) => `${target.kind}:${target.id}`

export function targetExists(review: ReviewDocument, target: Target): boolean {
  switch (target.kind) {
    case 'node': return review.nodes.some(item => item.id === target.id)
    case 'edge': return review.edges.some(item => item.id === target.id)
    case 'scene': return review.scenes.some(item => item.id === target.id)
    case 'review': return review.id === target.id
  }
}

export function targetSceneId(review: ReviewDocument, target: Target): string | undefined {
  switch (target.kind) {
    case 'node': return review.nodes.find(item => item.id === target.id)?.sceneId
    case 'edge': return review.edges.find(item => item.id === target.id)?.sceneId
    case 'scene': return review.scenes.find(item => item.id === target.id)?.id
    case 'review': return undefined
  }
}

export function targetLabel(review: ReviewDocument, target: Target): string {
  switch (target.kind) {
    case 'node': return review.nodes.find(item => item.id === target.id)?.title ?? `已移除节点 · ${target.id}`
    case 'edge': {
      const edge = review.edges.find(item => item.id === target.id)
      if (!edge) return `已移除连线 · ${target.id}`
      return `连线 · ${edge.label || `${review.nodes.find(node => node.id === edge.source)?.title ?? edge.source} → ${review.nodes.find(node => node.id === edge.target)?.title ?? edge.target}`}`
    }
    case 'scene': return review.scenes.some(item => item.id === target.id)
      ? `场景 · ${review.scenes.find(item => item.id === target.id)!.title}` : `已移除场景 · ${target.id}`
    case 'review': return review.id === target.id ? '整个评审' : `已移除评审 · ${target.id}`
  }
}

export function addComment(review: ReviewDocument, selected: Target[], body: string, basis?: ReviewComment['basis']): ReviewDocument {
  const checked = targets(selected)
  if (basis !== undefined) choice(basis, ['baseline'] as const, '批注依据')
  const document = basis === 'baseline' ? review.baseline : review
  if (!document || checked.some(target => !targetExists(document, target))) throw new Error(basis ? '基线批注必须引用固定基线 B 的现有目标' : '不能在已移除的目标上添加批注')
  const content = text(body.trim(), '批注内容', 10000, true)
  const result: ReviewDocument = { ...review, comments: [...review.comments, { id: newId(), targets: checked, body: content,
    status: 'open', createdAt: new Date().toISOString(), revision: review.revision, ...(basis ? { basis } : {}) }] }
  return result
}

export function addReply(review: ReviewDocument, commentId: string, body: string, author: CommentReply['author'] = 'reviewer'): ReviewDocument {
  const comment = review.comments.find(comment => comment.id === commentId)
  if (!comment) throw new Error('找不到此批注')
  choice(author, ['reviewer', 'agent'] as const, '回复作者')
  const reply: CommentReply = { id: newId(), author, body: text(body.trim(), '回复内容', 10000, true),
    createdAt: new Date().toISOString(), revision: review.revision }
  const result: ReviewDocument = { ...review, comments: review.comments.map(item => item.id === commentId
    ? { ...item, replies: [...(item.replies ?? []), reply], status: author === 'agent' ? 'needs-review' : item.status } : item) }
  return result
}

export function setCommentStatus(review: ReviewDocument, commentId: string, status: CommentStatus): ReviewDocument {
  choice(status, ['open', 'resolved', 'needs-review'] as const, '批注状态')
  if (!review.comments.some(comment => comment.id === commentId)) throw new Error('找不到此批注')
  const result = { ...review, comments: review.comments.map(comment => comment.id === commentId ? { ...comment, status, reviewedRevision: review.revision } : comment) }
  return result
}

function elements(review: ReviewDocument) {
  return [
    ...review.nodes.map(node => ({ target: { kind: 'node', id: node.id } as Target, content: nodeContent(node) })),
    ...review.edges.map(edge => ({ target: { kind: 'edge', id: edge.id } as Target, content: edgeContent(edge) })),
  ]
}

function nodeContent(node: ReviewNode) {
  return JSON.stringify([node.sceneId, node.title, node.kind, node.summary, node.detail, node.input, node.output,
    node.evidence.map(item => [item.path, item.symbol, item.startLine, item.endLine, item.digest])])
}

function edgeContent(edge: ReviewEdge) {
  return JSON.stringify([edge.sceneId, edge.source, edge.target, edge.label, edge.detail])
}

function sceneContent(review: ReviewDocument, sceneId: string) {
  const scene = review.scenes.find(scene => scene.id === sceneId)
  return JSON.stringify([scene ? [scene.title, scene.description] : null, review.nodes.filter(node => node.sceneId === sceneId).map(node => [node.id, nodeContent(node)]).sort(),
    review.edges.filter(edge => edge.sceneId === sceneId).map(edge => [edge.id, edgeContent(edge)]).sort()])
}

function reviewContent(review: ReviewDocument) {
  return JSON.stringify([review.title, review.description, review.coverage,
    review.scenes.map(scene => [scene.id, sceneContent(review, scene.id)]).sort()])
}

function mergeReplies(local: ReviewComment, incoming?: ReviewComment): { replies?: CommentReply[]; hasNewAgentReply: boolean } {
  if (local.replies === undefined && incoming?.replies === undefined) return { hasNewAgentReply: false }
  const merged = [...(local.replies ?? [])]
  const byId = new Map(merged.map(reply => [reply.id, reply]))
  let hasNewAgentReply = false
  for (const reply of incoming?.replies ?? []) {
    const existing = byId.get(reply.id)
    if (existing) {
      if (JSON.stringify([existing.author, existing.body, existing.createdAt, existing.revision]) !==
        JSON.stringify([reply.author, reply.body, reply.createdAt, reply.revision])) {
        throw new Error(`回复 ${reply.id} 的内容冲突；请先导出当前评审并处理冲突`)
      }
    } else {
      merged.push(reply)
      byId.set(reply.id, reply)
      if (reply.author === 'agent') hasNewAgentReply = true
    }
  }
  return { replies: merged, hasNewAgentReply }
}

export function getChanges(previous: ReviewDocument, next: ReviewDocument): ReviewChanges {
  const before = new Map(elements(previous).map(item => [targetKey(item.target), item]))
  const after = new Map(elements(next).map(item => [targetKey(item.target), item]))
  return {
    added: [...after].filter(([key]) => !before.has(key)).map(([, item]) => item.target),
    changed: [...after].filter(([key, item]) => before.has(key) && before.get(key)!.content !== item.content).map(([, item]) => item.target),
    removed: [...before].filter(([key]) => !after.has(key)).map(([, item]) => item.target),
  }
}

export function rebaseReview(previous: ReviewDocument, next: ReviewDocument): ReviewDocument {
  if (previous.id !== next.id) throw new Error('只能合并相同评审 ID 的版本')
  if (previous.baseline && next.baseline && JSON.stringify(previous.baseline) !== JSON.stringify(next.baseline)) throw new Error('固定基线已存在，不能随新版替换')
  const changes = getChanges(previous, next)
  const affected = new Set([...changes.changed, ...changes.removed].map(targetKey))
  const revisionChanged = previous.revision !== next.revision || previous.snapshot.fingerprint !== next.snapshot.fingerprint
  const incoming = new Map(next.comments.map(comment => [comment.id, comment]))
  const baseline = previous.baseline ?? next.baseline
  if ([...previous.comments, ...next.comments].some(comment => comment.basis === 'baseline' &&
    (!baseline || comment.targets.some(target => !targetExists(baseline, target))))) throw new Error('基线批注必须引用固定基线 B 的现有目标')
  for (const comment of previous.comments) {
    const match = incoming.get(comment.id)
    if (match && (comment.body !== match.body || comment.basis !== match.basis || JSON.stringify(comment.targets.map(targetKey).sort()) !== JSON.stringify(match.targets.map(targetKey).sort()))) {
      throw new Error(`批注 ${comment.id} 的内容或目标冲突；请先导出当前评审并处理冲突`)
    }
  }
  const localIds = new Set(previous.comments.map(comment => comment.id))
  const changedScenes = new Set([...previous.scenes, ...next.scenes].filter(scene => sceneContent(previous, scene.id) !== sceneContent(next, scene.id)).map(scene => scene.id))
  const reviewChanged = reviewContent(previous) !== reviewContent(next)
  const carried = previous.comments.map(comment => {
    const { replies, hasNewAgentReply } = mergeReplies(comment, incoming.get(comment.id))
    const scopeChanged = comment.targets.some(target => affected.has(targetKey(target)) ||
      (target.kind === 'scene' && changedScenes.has(target.id)) || (target.kind === 'review' && reviewChanged))
    return { ...comment, ...(replies === undefined ? {} : { replies }),
      status: revisionChanged || (comment.reviewedRevision ?? comment.revision) !== next.revision || scopeChanged || hasNewAgentReply ||
        (comment.status !== 'resolved' && comment.targets.some(target => !targetExists(comment.basis === 'baseline' ? baseline! : next, target)))
        ? 'needs-review' as const : comment.status,
    }
  })
  const imported = next.comments.filter(comment => !localIds.has(comment.id)).map(comment => ({ ...comment,
    status: (comment.reviewedRevision ?? comment.revision) !== next.revision || (comment.status !== 'resolved' && comment.targets.some(target => !targetExists(comment.basis === 'baseline' ? baseline! : next, target))) ? 'needs-review' as const : comment.status,
  }))
  const result = { ...next, ...(baseline ? { baseline } : {}), comments: [...carried, ...imported] }
  return result
}
