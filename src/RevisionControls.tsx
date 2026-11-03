import { FileDiff, LockKeyhole, MapPin } from 'lucide-react'
import { targetLabel } from './model.ts'
import type { RevisionChanges } from './revisions.ts'
import type { CurrentSession } from './session-types.ts'
import type { ReviewDocument, Target } from './types.ts'

interface RevisionControlsProps {
  session: Pick<CurrentSession, 'round' | 'snapshots'>
  viewRound: number
  onViewRound: (round: number) => void
  onOpenChanges: () => void
}

export default function RevisionControls({ session, viewRound, onViewRound, onOpenChanges }: RevisionControlsProps) {
  const current = session.snapshots.find(snapshot => snapshot.round === session.round)
  const baseRound = current?.publication?.baseRound ?? session.round - 1
  const before = session.snapshots.find(snapshot => snapshot.round === baseRound)
  const historical = viewRound !== session.round
  return <div className="revision-controls" aria-label="流程图版本">
    <div className="revision-switch" role="group" aria-label="切换流程图版本">
      {before && <button className="button" aria-pressed={viewRound === baseRound} onClick={() => onViewRound(baseRound)}>修改前 R{baseRound}</button>}
      <button className="button" aria-pressed={!historical} onClick={() => onViewRound(session.round)}>当前 R{session.round}</button>
    </div>
    {historical && <span className="revision-readonly"><LockKeyhole size={12} />{viewRound === baseRound ? '只读' : `提出时 R${viewRound} · 只读`}</span>}
    {before && <button className="button revision-changes-button" onClick={onOpenChanges}><FileDiff size={14} />本轮变化</button>}
  </div>
}

interface RevisionChangesPanelProps {
  before: ReviewDocument
  after: ReviewDocument
  changes: RevisionChanges
  onLocate: (target: Target, side: 'before' | 'after') => void
}

type Field = { label: string; value: string }
const kindLabels = { action: '操作', decision: '判断', result: '结果', failure: '失败出口' }

function fields(review: ReviewDocument, target: Target): Field[] {
  const sceneTitle = (sceneId: string) => `${review.scenes.find(scene => scene.id === sceneId)?.title ?? sceneId} · ${sceneId}`
  if (target.kind === 'node') {
    const node = review.nodes.find(item => item.id === target.id)
    return node ? [
      { label: '标题', value: node.title }, { label: '类型', value: kindLabels[node.kind] },
      { label: '场景', value: sceneTitle(node.sceneId) }, { label: '摘要', value: node.summary },
      { label: '规则说明', value: node.detail }, { label: '输入', value: node.input }, { label: '输出', value: node.output },
    ] : []
  }
  if (target.kind === 'edge') {
    const edge = review.edges.find(item => item.id === target.id)
    return edge ? [
      { label: '条件', value: edge.label }, { label: '规则说明', value: edge.detail },
      { label: '起点', value: `${targetLabel(review, { kind: 'node', id: edge.source })} · ${edge.source}` },
      { label: '终点', value: `${targetLabel(review, { kind: 'node', id: edge.target })} · ${edge.target}` },
      { label: '场景', value: sceneTitle(edge.sceneId) },
    ] : []
  }
  if (target.kind === 'scene') {
    const scene = review.scenes.find(item => item.id === target.id)
    return scene ? [{ label: '标题', value: scene.title }, { label: '说明', value: scene.description }] : []
  }
  return [
    { label: '评审标题', value: review.title }, { label: '评审说明', value: review.description },
    { label: '已覆盖范围', value: review.coverage.included.join('\n') },
    { label: '未覆盖范围', value: review.coverage.excluded.join('\n') },
    { label: '范围说明', value: review.coverage.note },
    { label: '场景', value: review.scenes.map(scene => `${scene.title}\n${scene.description}`).join('\n\n') },
  ]
}

function evidence(review: ReviewDocument, target: Target): string {
  return review.nodes.find(node => target.kind === 'node' && node.id === target.id)?.evidence
    .map(item => `${item.path}:${item.startLine}–${item.endLine} · ${item.symbol}\n${item.digest}`).join('\n\n') ?? ''
}

function FieldChanges({ before, after }: { before: Field[]; after: Field[] }) {
  return <dl className="revision-field-changes">{after.flatMap(field => {
    const previous = before.find(item => item.label === field.label)?.value ?? ''
    return previous === field.value ? [] : [<div key={field.label}>
      <dt>{field.label}</dt><dd className="revision-before"><span>修改前</span><p>{previous || '（空）'}</p></dd>
      <dd className="revision-after"><span>当前</span><p>{field.value || '（空）'}</p></dd>
    </div>]
  })}</dl>
}

export function RevisionChangesPanel({ before, after, changes, onLocate }: RevisionChangesPanelProps) {
  const groups = [
    { key: 'added', label: '新增', targets: changes.added },
    { key: 'changed', label: '修改', targets: changes.changed },
    { key: 'removed', label: '移除', targets: changes.removed },
    { key: 'evidence', label: '源码依据更新', targets: changes.evidenceChanged },
  ] as const
  const logicCount = changes.added.length + changes.changed.length + changes.removed.length
  return <section className="revision-changes-panel" aria-label="本轮变化">
    <div className="revision-panel-heading"><h3>本轮变化</h3><p className="muted">固定对照本轮发布的修改前与当前快照。排版移动不计入逻辑变化。</p></div>
    {!logicCount && <p className="revision-unchanged">本轮流程无逻辑变化{changes.evidenceChanged.length ? '，源码依据已更新。' : '。'}</p>}
    {groups.map(group => !!group.targets.length && <section key={group.key} className="revision-change-group" aria-label={`${group.label}项`}>
      <h4><span className={`revision-dot revision-${group.key}`} />{group.label}<span className="muted">{group.targets.length}</span></h4>
      {group.targets.map(target => {
        const side = group.key === 'removed' ? 'before' : 'after'
        const document = side === 'before' ? before : after
        return <article className={`revision-change-entry revision-${group.key}`} key={`${target.kind}:${target.id}`}>
          <strong>{targetLabel(document, target)}</strong>
          <div className="revision-locate-actions">
            {group.key === 'changed' || group.key === 'evidence' ? <>
              <button className="button" aria-label={`查看修改前：${targetLabel(before, target)}`} onClick={() => onLocate(target, 'before')}><MapPin size={12} />修改前</button>
              <button className="button" aria-label={`查看当前：${targetLabel(after, target)}`} onClick={() => onLocate(target, 'after')}><MapPin size={12} />当前</button>
            </> : <button className="button" aria-label={`定位${group.key === 'removed' ? '原' : '当前'}位置：${targetLabel(document, target)}`} onClick={() => onLocate(target, side)}><MapPin size={12} />{group.key === 'removed' ? '在修改前查看' : '在当前查看'}</button>}
          </div>
          {group.key === 'changed' && <FieldChanges before={fields(before, target)} after={fields(after, target)} />}
          {group.key === 'evidence' && <FieldChanges before={[{ label: '源码依据', value: evidence(before, target) }]} after={[{ label: '源码依据', value: evidence(after, target) }]} />}
          {(group.key === 'added' || group.key === 'removed') && <p className="revision-entry-summary">{fields(document, target).find(field => field.label === '摘要' || field.label === '规则说明')?.value || '查看图中位置与完整详情。'}</p>}
        </article>
      })}
    </section>)}
    {changes.metadataChanged && <section className="revision-change-group revision-metadata" aria-label="评审范围更新"><h4>评审范围更新</h4><FieldChanges before={fields(before, { kind: 'review', id: before.id })} after={fields(after, { kind: 'review', id: after.id })} /></section>}
  </section>
}
