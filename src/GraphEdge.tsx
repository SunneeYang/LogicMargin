import { memo } from 'react'
import { BaseEdge } from '@xyflow/react'
import type { Edge, EdgeProps } from '@xyflow/react'
import type { LayoutEdge } from './graph-layout.ts'

export type FlowRelation = 'incoming' | 'outgoing' | 'selected'
export type FlowEdge = Edge<{ route: LayoutEdge; relation?: FlowRelation }, 'review'>

export const relationColors: Record<FlowRelation, string> = {
  incoming: 'var(--color-accent)', outgoing: 'var(--color-success)', selected: 'var(--color-accent)',
}

export default memo(function GraphEdge({ id, data, label, markerEnd, style, interactionWidth }: EdgeProps<FlowEdge>) {
  if (!data) return null
  const path = data.route.points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ')
  return <>
    <path className="edge-crossing-gap" d={path} fill="none" strokeWidth={8} />
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth}
      label={label} labelX={data.route.label.x} labelY={data.route.label.y}
      labelBgPadding={[6, 4]} labelBgBorderRadius={4} />
    {data.relation && <path className="edge-flow-light" d={path} fill="none"
      style={{ stroke: relationColors[data.relation], color: relationColors[data.relation] }} aria-hidden="true" />}
  </>
})
