import { memo } from 'react'
import { BaseEdge } from '@xyflow/react'
import type { Edge, EdgeProps } from '@xyflow/react'
import type { LayoutEdge } from './graph-layout.ts'
import { smoothEdgePath } from './graph-path.ts'
import { measureEdgeLabel } from './graph-label.ts'
import { useI18n } from './i18n.ts'

export type FlowRelation = 'incoming' | 'outgoing' | 'selected'
export type FlowEdge = Edge<{ route: LayoutEdge; relation?: FlowRelation; pulse?: number; status?: string; hasComment?: boolean }, 'review'>

export const relationColors: Record<FlowRelation, string> = {
  incoming: 'var(--color-edge-selected)', outgoing: 'var(--color-edge-selected)', selected: 'var(--color-edge-selected)',
}

export default memo(function GraphEdge({ id, data, label, markerEnd, style, interactionWidth, sourceX, sourceY, targetX, targetY }: EdgeProps<FlowEdge>) {
  const { t } = useI18n()
  if (!data) return null
  const points = data.route.points.map((point, index) => index === 0 ? { x: sourceX, y: sourceY }
    : index === data.route.points.length - 1 ? { x: targetX, y: targetY } : point)
  const path = smoothEdgePath(points)
  const lines = measureEdgeLabel(String(label ?? '')).lines
  const status = data.status
    ? data.hasComment ? t('{change} · 有批注', { change: t(data.status) }) : t(data.status)
    : data.hasComment ? t('有批注') : ''
  const statusLines = status ? measureEdgeLabel(status).lines : []
  const rows = lines.length + statusLines.length
  return <>
    <path className="edge-crossing-gap" d={path} fill="none" strokeWidth={8} />
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth}
      label={<>{lines.map((line, index) => <tspan key={index} x="0" dy={index ? 16 : -(rows - 1) * 8}>{line}</tspan>)}{statusLines.map((line, index) => <tspan key={`status-${index}`} x="0" dy="16" className="edge-change-label">{line}</tspan>)}</>} labelX={data.route.label.x} labelY={data.route.label.y}
      labelBgPadding={[6, 4]} labelBgBorderRadius={4} />
    {data.relation && !!data.pulse && <path key={data.pulse} className="edge-flow-light" d={path} fill="none" pathLength={100}
      aria-hidden="true" />}
  </>
})
