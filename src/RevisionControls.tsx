import { FileDiff, LockKeyhole, MapPin } from 'lucide-react'
import { targetLabel } from './model.ts'
import type { RevisionChanges } from './revisions.ts'
import type { CurrentSession } from './session-types.ts'
import type { ReviewDocument, Target } from './types.ts'
import { graphVersionLabel } from './revisions.ts'
import { useI18n } from './i18n.ts'
import type { Translator } from './i18n.ts'

interface RevisionControlsProps {
  session?: Pick<CurrentSession, 'round' | 'snapshots' | 'baselineReview'>
  viewRound: number
  onViewRound: (round: number) => void
  onOpenChanges: () => void
  baseline?: {
    showing: boolean
    source: 'baseline' | 'previous'
    onSourceChange: (source: 'baseline' | 'previous') => void
    onShow: () => void
  }
}

export default function RevisionControls({ session, viewRound, onViewRound, onOpenChanges, baseline }: RevisionControlsProps) {
  const { t } = useI18n()
  const round = session?.round ?? 1
  const planning = !!session?.baselineReview && round === 1
  const current = session?.snapshots.find(snapshot => snapshot.round === round)
  const baseRound = current?.publication?.baseRound ?? round - 1
  const before = session?.snapshots.find(snapshot => snapshot.round === baseRound && !(session.baselineReview && baseRound === 1))
  const label = (value: number) => session?.baselineReview && value === 1 ? t('基线 B') : graphVersionLabel(session ?? {}, value)
  const comparingBaseline = baseline?.source === 'baseline'
  const historical = !!baseline?.showing || viewRound !== round
  return <div className="revision-controls" aria-label={t('流程图版本')}>
    {baseline && before && <select className="comparison-source" aria-label={t('比较依据')} value={baseline.source} onChange={event => baseline.onSourceChange(event.target.value as 'baseline' | 'previous')}>
      <option value="baseline">{t('相对基线 B')}</option><option value="previous">{t('相对上一轮 {version}', { version: label(baseRound) })}</option>
    </select>}
    {!before && !baseline && !historical ? <span className="revision-current">{session ? t('第 {round} 轮', { round }) : t('当前流程')}</span> : <div className="revision-switch" role="group" aria-label={t('切换流程图版本')}>
      {comparingBaseline ? <button className="button" aria-pressed={baseline.showing} onClick={baseline.onShow}>{t('基线 B')}</button>
        : before && <button className="button" aria-pressed={viewRound === baseRound} onClick={() => onViewRound(baseRound)}>{t('修改前 {version}', { version: label(baseRound) })}</button>}
      {!planning && <button className="button" aria-pressed={!historical} onClick={() => { if (historical) onViewRound(round) }}>{session ? t('当前 {version}', { version: label(round) }) : t('修改后')}</button>}
    </div>}
    {historical && !baseline?.showing && <span className="revision-readonly"><LockKeyhole size={12} />{viewRound === baseRound ? t('只读') : t('提出时 {version} · 只读', { version: label(viewRound) })}</span>}
    <button className="button revision-changes-button" onClick={onOpenChanges}><FileDiff size={14} />{t(comparingBaseline ? '本次改动' : before ? '本轮变化' : '变更对比')}</button>
  </div>
}

interface RevisionChangesPanelProps {
  before: ReviewDocument
  after: ReviewDocument
  changes: RevisionChanges
  onLocate: (target: Target, side: 'before' | 'after') => void
  comparisonLabel?: string
}

type Field = { label: string; value: string }
const kindLabels = { action: '操作', decision: '判断', result: '结果', failure: '失败出口' }

function fields(review: ReviewDocument, target: Target, t: Translator): Field[] {
  const sceneTitle = (sceneId: string) => `${review.scenes.find(scene => scene.id === sceneId)?.title ?? sceneId} · ${sceneId}`
  if (target.kind === 'node') {
    const node = review.nodes.find(item => item.id === target.id)
    return node ? [
      { label: '标题', value: node.title }, { label: '类型', value: t(kindLabels[node.kind]) },
      { label: '场景', value: sceneTitle(node.sceneId) }, { label: '摘要', value: node.summary },
      { label: '规则说明', value: node.detail }, { label: '输入', value: node.input }, { label: '输出', value: node.output },
    ] : []
  }
  if (target.kind === 'edge') {
    const edge = review.edges.find(item => item.id === target.id)
    return edge ? [
      { label: '条件', value: edge.label }, { label: '规则说明', value: edge.detail },
      { label: '起点', value: `${targetLabel(review, { kind: 'node', id: edge.source }, t)} · ${edge.source}` },
      { label: '终点', value: `${targetLabel(review, { kind: 'node', id: edge.target }, t)} · ${edge.target}` },
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
  const { t } = useI18n()
  return <dl className="revision-field-changes">{after.flatMap(field => {
    const previous = before.find(item => item.label === field.label)?.value ?? ''
    return previous === field.value ? [] : [<div key={field.label}>
      <dt>{t(field.label)}</dt><dd className="revision-before"><span>{t('修改前')}</span><p>{previous || t('（空）')}</p></dd>
      <dd className="revision-after"><span>{t('当前')}</span><p>{field.value || t('（空）')}</p></dd>
    </div>]
  })}</dl>
}

export function RevisionChangesPanel({ before, after, changes, onLocate, comparisonLabel }: RevisionChangesPanelProps) {
  const { t } = useI18n()
  const comparingBaseline = comparisonLabel === '本次改动' || comparisonLabel === t('本次改动')
  const heading = comparisonLabel ?? t('本轮变化')
  const groups = [
    { key: 'added', label: '新增', targets: changes.added },
    { key: 'changed', label: '修改', targets: changes.changed },
    { key: 'removed', label: '移除', targets: changes.removed },
    { key: 'evidence', label: '源码依据更新', targets: changes.evidenceChanged },
  ] as const
  const logicCount = changes.added.length + changes.changed.length + changes.removed.length
  return <section className="revision-changes-panel" aria-label={heading}>
    <div className="revision-panel-heading"><h3>{heading}</h3><p className="muted">{t(comparingBaseline ? '对照固定基线 B 与当前流程。排版移动不计入逻辑变化。' : '固定对照本轮发布的修改前与当前快照。排版移动不计入逻辑变化。')}</p></div>
    {!logicCount && <p className="revision-unchanged">{t(comparingBaseline ? changes.evidenceChanged.length ? '相对基线 B 无逻辑变化，源码依据已更新。' : '相对基线 B 无逻辑变化。' : changes.evidenceChanged.length ? '本轮流程无逻辑变化，源码依据已更新。' : '本轮流程无逻辑变化。')}</p>}
    {groups.map(group => !!group.targets.length && <section key={group.key} className="revision-change-group" aria-label={t('{kind}项', { kind: t(group.label) })}>
      <h4><span className={`revision-dot revision-${group.key}`} />{t(group.label)}<span className="muted">{group.targets.length}</span></h4>
      {group.targets.map(target => {
        const side = group.key === 'removed' ? 'before' : 'after'
        const document = side === 'before' ? before : after
        return <article className={`revision-change-entry revision-${group.key}`} key={`${target.kind}:${target.id}`}>
          <strong>{targetLabel(document, target, t)}</strong>
          <div className="revision-locate-actions">
            {group.key === 'changed' || group.key === 'evidence' ? <>
              <button className="button" aria-label={t('查看修改前：{target}', { target: targetLabel(before, target, t) })} onClick={() => onLocate(target, 'before')}><MapPin size={12} />{t('修改前')}</button>
              <button className="button" aria-label={t('查看当前：{target}', { target: targetLabel(after, target, t) })} onClick={() => onLocate(target, 'after')}><MapPin size={12} />{t('当前')}</button>
            </> : <button className="button" aria-label={t(group.key === 'removed' ? '定位原位置：{target}' : '定位当前位置：{target}', { target: targetLabel(document, target, t) })} onClick={() => onLocate(target, side)}><MapPin size={12} />{t(group.key === 'removed' ? '在修改前查看' : '在当前查看')}</button>}
          </div>
          {group.key === 'changed' && <FieldChanges before={fields(before, target, t)} after={fields(after, target, t)} />}
          {group.key === 'evidence' && <FieldChanges before={[{ label: '源码依据', value: evidence(before, target) }]} after={[{ label: '源码依据', value: evidence(after, target) }]} />}
          {(group.key === 'added' || group.key === 'removed') && <p className="revision-entry-summary">{fields(document, target, t).find(field => field.label === '摘要' || field.label === '规则说明')?.value || t('查看图中位置与完整详情。')}</p>}
        </article>
      })}
    </section>)}
    {changes.metadataChanged && <section className="revision-change-group revision-metadata" aria-label={t('评审范围更新')}><h4>{t('评审范围更新')}</h4><FieldChanges before={fields(before, { kind: 'review', id: before.id }, t)} after={fields(after, { kind: 'review', id: after.id }, t)} /></section>}
  </section>
}
