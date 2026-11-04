import { memo } from 'react'
import { BaseEdge } from '@xyflow/react'
import type { Edge, EdgeProps } from '@xyflow/react'
import type { LayoutEdge } from './graph-layout.ts'
import { smoothEdgePath } from './graph-path.ts'

export type FlowRelation = 'incoming' | 'outgoing' | 'selected'
export type FlowEdge = Edge<{ route: LayoutEdge; relation?: FlowRelation; pulse?: number }, 'review'>

export const relationColors: Record<FlowRelation, string> = {
  incoming: 'var(--color-edge-selected)', outgoing: 'var(--color-edge-selected)', selected: 'var(--color-edge-selected)',
}

export default memo(function GraphEdge({ id, data, label, markerEnd, style, interactionWidth, sourceX, sourceY, targetX, targetY }: EdgeProps<FlowEdge>) {
  if (!data) return null
  const points = data.route.points.map((point, index) => index === 0 ? { x: sourceX, y: sourceY }
    : index === data.route.points.length - 1 ? { x: targetX, y: targetY } : point)
  const path = smoothEdgePath(points)
  return <>
    <path className="edge-crossing-gap" d={path} fill="none" strokeWidth={8} />
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth}
      label={label} labelX={data.route.label.x} labelY={data.route.label.y}
      labelBgPadding={[6, 4]} labelBgBorderRadius={4} />
    {data.relation && !!data.pulse && <path key={data.pulse} className="edge-flow-light" d={path} fill="none" pathLength={100}
      aria-hidden="true" />}
  </>
})
