import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import {
  ReactFlow, Background, Controls, Handle, Position, SelectionMode,
  MarkerType, useNodesState, useEdgesState,
} from '@xyflow/react'
import type { Edge, EdgeChange, Node, NodeProps, OnSelectionChangeParams, ReactFlowInstance } from '@xyflow/react'
import { ChevronRight, MessageSquare, Pencil } from 'lucide-react'
import type { ReviewChanges, ReviewDocument, ReviewNode, Target } from './types.ts'
import { targetExists, targetLabel, targetSceneId } from './model.ts'

type Point = { x: number; y: number }
type TargetRect = { left: number; right: number; top: number; bottom: number }

export interface GraphCanvasProps {
  review: ReviewDocument
  sceneId: string
  selection: Target[]
  setSelection: (targets: Target[]) => void
  changes: ReviewChanges
  mode: 'pan' | 'select'
  onOpenComposer: (targets: Target[], point?: Point) => void
  onOpenThread: (commentId: string, point?: Point) => void
  onViewportChange?: () => void
  draftTargets?: Target[]
}

export interface GraphCanvasHandle {
  getTargetRect: (targets: Target[]) => TargetRect | null
  getCanvasRect: () => DOMRect | null
  focusTargets: (targets: Target[]) => void
}

type FlowNode = Node<{
  item: ReviewNode
  count: number
  changed: boolean
  hasBranch: boolean
  onComment: (target: Target, point: Point) => void
}, 'review'>

const kindLabels = { action: '操作', decision: '判断', result: '结果', failure: '失败出口' }
const keyOf = (target: Target) => `${target.kind}:${target.id}`

function ReviewNodeView({ data }: NodeProps<FlowNode>) {
  return <div className={`review-node kind-${data.item.kind} ${data.count ? 'has-comment' : ''} ${data.changed ? 'changed' : ''}`}>
    <Handle type="target" position={Position.Top} />
    <div className="node-topline">
      <span className="node-kind">{kindLabels[data.item.kind]}</span>
      {data.changed && <span className="badge">已变化</span>}
      <button className={`node-comment-button nodrag nopan ${data.count ? '' : 'is-empty'}`}
        aria-label={`批注：${data.item.title}${data.count ? `（${data.count} 条）` : ''}`}
        onClick={event => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          data.onComment({ kind: 'node', id: data.item.id }, { x: rect.right, y: rect.bottom })
        }}>
        <MessageSquare size={13} /><span>{data.count || '批注'}</span>
      </button>
    </div>
    <strong className="node-title">{data.item.title}</strong>
    <p className="node-summary">{data.item.summary}</p>
    <div className="node-footer">查看步骤与数据 <ChevronRight size={12} /></div>
    <Handle type="source" position={Position.Bottom} />
    {data.hasBranch && <Handle id="branch" type="source" position={Position.Right} />}
  </div>
}

const nodeTypes = { review: ReviewNodeView }
const graphAriaLabels = {
  'controls.zoomIn.ariaLabel': '放大流程',
  'controls.zoomOut.ariaLabel': '缩小流程',
  'controls.fitView.ariaLabel': '显示完整流程',
  'node.a11yDescription.default': '按回车或空格选择步骤。按住 Shift 可多选。',
  'edge.a11yDescription.default': '按回车或空格选择连线。按住 Shift 可多选。',
}

const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas({
  review, sceneId, selection, setSelection, changes, mode,
  onOpenComposer, onOpenThread, onViewportChange, draftTargets = [],
}, ref) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<Edge>([])
  const selectionRef = useRef(selection)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null)
  const marqueeRef = useRef(false)
  const layoutReady = useRef(false)
  const canvasSize = useRef({ width: 0, height: 0 })
  const layoutFrame = useRef(0)
  const pendingFocus = useRef<string[] | null>(null)
  selectionRef.current = selection

  const sceneNodes = useMemo(() => review.nodes.filter(node => node.sceneId === sceneId), [review.nodes, sceneId])
  const multiObjectComments = review.comments.filter(comment => comment.targets.length > 1
    && comment.targets.some(target => targetSceneId(review, target) === sceneId))
  const hasSceneDraft = draftTargets.length > 0 && draftTargets.every(target => targetExists(review, target))
    && draftTargets.some(target => target.kind === 'review' || targetSceneId(review, target) === sceneId)

  const updateLayout = useCallback(() => {
    const flow = flowRef.current
    const canvas = canvasRef.current
    if (!flow || !canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    const items = flow.getNodes()
    if (!layoutReady.current) {
      if (!items.length || items.some(node => !node.measured?.width || !node.measured?.height)) return
      layoutReady.current = true
      canvasSize.current = { width, height }
      const markReady = () => { canvas.dataset.viewportReady = 'true' }
      if (pendingFocus.current) {
        void flow.fitView({ nodes: pendingFocus.current.map(id => ({ id })), padding: 0.2, maxZoom: 0.9, duration: 0 }).then(markReady)
        pendingFocus.current = null
        return
      }
      const zoom = 0.85
      let bounds = flow.getNodesBounds(items)
      if (bounds.width * zoom > width - 48) {
        const firstColumn = Math.min(...items.map(node => node.position.x))
        bounds = flow.getNodesBounds(items.filter(node => node.position.x === firstColumn))
      }
      void flow.setViewport({ x: Math.max(24, (width - bounds.width * zoom) / 2) - bounds.x * zoom, y: 32 - bounds.y * zoom, zoom }, { duration: 0 }).then(markReady)
      return
    }
    const previous = canvasSize.current
    if (previous.width === width && previous.height === height) return
    canvasSize.current = { width, height }
    const viewport = flow.getViewport()
    let x = viewport.x + (width - previous.width) / 2
    let y = viewport.y
    const selectedIds = new Set(selectionRef.current.flatMap(target => {
      if (target.kind === 'node') return [target.id]
      if (target.kind === 'edge') {
        const edge = flow.getEdge(target.id)
        return edge ? [edge.source, edge.target] : []
      }
      return []
    }))
    // Only protect an already-visible target; a stale selection must not undo manual panning.
    const anchor = items.find(node => {
      if (!selectedIds.has(node.id)) return false
      const rect = flow.getNodesBounds([node])
      const left = viewport.x + rect.x * viewport.zoom
      const top = viewport.y + rect.y * viewport.zoom
      return left < previous.width && left + rect.width * viewport.zoom > 0 && top < previous.height && top + rect.height * viewport.zoom > 0
    })
    if (anchor) {
      const rect = flow.getNodesBounds([anchor])
      const nodeWidth = rect.width * viewport.zoom
      const nodeHeight = rect.height * viewport.zoom
      if (nodeWidth <= width - 48) {
        x = Math.max(24 - rect.x * viewport.zoom, Math.min(x, width - 24 - (rect.x + rect.width) * viewport.zoom))
      }
      if (nodeHeight <= height - 48 && height < previous.height) {
        y = Math.max(24 - rect.y * viewport.zoom, Math.min(y, height - 24 - (rect.y + rect.height) * viewport.zoom))
      }
    }
    void flow.setViewport({ x, y, zoom: viewport.zoom }, { duration: 0 })
  }, [])

  const scheduleLayout = useCallback(() => {
    cancelAnimationFrame(layoutFrame.current)
    layoutFrame.current = requestAnimationFrame(updateLayout)
  }, [updateLayout])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(scheduleLayout)
    observer.observe(canvas)
    scheduleLayout()
    return () => { observer.disconnect(); cancelAnimationFrame(layoutFrame.current) }
  }, [scheduleLayout])

  useEffect(() => {
    if (!layoutReady.current) scheduleLayout()
  }, [nodes, scheduleLayout])

  const openComposer = useCallback((targets: Target[], point?: Point) => {
    setSelection(targets)
    onOpenComposer(targets, point)
  }, [setSelection, onOpenComposer])

  const openNodeComment = useCallback((target: Target, point: Point) => {
    const latest = review.comments.findLast(comment => comment.targets.some(item => keyOf(item) === keyOf(target)))
    if (latest) onOpenThread(latest.id, point)
    else openComposer([target], point)
  }, [review.comments, onOpenThread, openComposer])

  useEffect(() => {
    const failureIds = new Set(review.nodes.filter(node => node.kind === 'failure').map(node => node.id))
    const branchSources = new Set(review.edges.filter(edge => failureIds.has(edge.target)).map(edge => edge.source))
    setNodes(sceneNodes.map(item => ({
      id: item.id, type: 'review', position: item.position, ariaLabel: item.title,
      selected: selectionRef.current.some(target => target.kind === 'node' && target.id === item.id),
      data: {
        item,
        count: review.comments.filter(comment => comment.targets.some(target => target.kind === 'node' && target.id === item.id)).length,
        changed: [...changes.added, ...changes.changed].some(target => target.kind === 'node' && target.id === item.id),
        hasBranch: branchSources.has(item.id), onComment: openNodeComment,
      },
    })))
    setEdges(review.edges.filter(edge => edge.sceneId === sceneId).map(item => ({
      id: item.id, source: item.source, target: item.target,
      sourceHandle: failureIds.has(item.target) ? 'branch' : undefined,
      label: `${item.label}${review.comments.some(comment => comment.targets.some(target => target.kind === 'edge' && target.id === item.id)) ? ' · 有批注' : ''}`,
      type: 'smoothstep', ariaLabel: `${targetLabel(review, { kind: 'node', id: item.source })}：${item.label}`,
      selected: selectionRef.current.some(target => target.kind === 'edge' && target.id === item.id),
      markerEnd: { type: MarkerType.ArrowClosed }, interactionWidth: 28,
    })))
  }, [sceneNodes, review, sceneId, changes, setNodes, setEdges, openNodeComment])

  useEffect(() => {
    setNodes(items => items.map(node => ({ ...node, selected: selection.some(target => target.kind === 'node' && target.id === node.id) })))
    setEdges(items => items.map(edge => ({ ...edge, selected: selection.some(target => target.kind === 'edge' && target.id === edge.id) })))
  }, [selection, setNodes, setEdges])

  const onEdgesChange = useCallback((edgeChanges: EdgeChange<Edge>[]) => {
    // React Flow includes connected edges in a marquee. Keep edges an explicit selection.
    applyEdgeChanges(marqueeRef.current
      ? edgeChanges.filter(change => change.type !== 'select' || !change.selected)
      : edgeChanges)
  }, [applyEdgeChanges])

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
    const next: Target[] = [
      ...selectedNodes.map(node => ({ kind: 'node' as const, id: node.id })),
      ...selectedEdges.map(edge => ({ kind: 'edge' as const, id: edge.id })),
    ]
    if (JSON.stringify(next.map(keyOf).sort()) !== JSON.stringify(selectionRef.current.map(keyOf).sort())) setSelection(next)
  }, [setSelection])

  useImperativeHandle(ref, () => ({
    getCanvasRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    getTargetRect: targets => {
      const canvas = canvasRef.current
      if (!canvas) return null
      if (targets.some(target => target.kind === 'scene' || target.kind === 'review')) return canvas.getBoundingClientRect()
      const rects = targets.flatMap(target => {
        const selector = `.react-flow__${target.kind}[data-id="${CSS.escape(target.id)}"]`
        const element = canvas.querySelector(selector)
        return element ? [element.getBoundingClientRect()] : []
      })
      if (!rects.length) return null
      return {
        left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)),
        top: Math.min(...rects.map(rect => rect.top)), bottom: Math.max(...rects.map(rect => rect.bottom)),
      }
    },
    focusTargets: targets => {
      const nodeIds = new Set<string>()
      if (targets.some(target => target.kind === 'scene' || target.kind === 'review')) {
        sceneNodes.forEach(node => nodeIds.add(node.id))
      } else {
        targets.forEach(target => {
          if (targetSceneId(review, target) !== sceneId) return
          if (target.kind === 'node') nodeIds.add(target.id)
          if (target.kind === 'edge') {
            const edge = review.edges.find(item => item.id === target.id)
            if (edge) { nodeIds.add(edge.source); nodeIds.add(edge.target) }
          }
        })
      }
      if (nodeIds.size) {
        if (layoutReady.current) void flowRef.current?.fitView({ nodes: [...nodeIds].map(id => ({ id })), padding: 0.2, maxZoom: 0.9, duration: 0 })
        else { pendingFocus.current = [...nodeIds]; scheduleLayout() }
      }
    },
  }), [review, sceneId, sceneNodes, scheduleLayout])

  return <div ref={canvasRef} className="canvas" aria-label="业务流程画布" onPointerCancelCapture={() => { marqueeRef.current = false }}>
    <ReactFlow<FlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="system"
      onInit={instance => { flowRef.current = instance; scheduleLayout() }} onMove={onViewportChange}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={onSelectionChange}
      onSelectionStart={() => { marqueeRef.current = true }} onSelectionEnd={() => { marqueeRef.current = false }}
      onNodeContextMenu={(event, node) => { event.preventDefault(); openComposer([{ kind: 'node', id: node.id }], { x: event.clientX, y: event.clientY }) }}
      onEdgeContextMenu={(event, edge) => { event.preventDefault(); openComposer([{ kind: 'edge', id: edge.id }], { x: event.clientX, y: event.clientY }) }}
      onEdgeDoubleClick={(event, edge) => openComposer([{ kind: 'edge', id: edge.id }], { x: event.clientX, y: event.clientY })}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      selectionOnDrag={mode === 'select'} selectionKeyCode={null} selectionMode={SelectionMode.Partial}
      panOnDrag={mode === 'pan' ? [0, 1, 2] : [1, 2]} multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
      defaultViewport={{ x: 36, y: 32, zoom: 0.85 }} minZoom={0.2} maxZoom={1.6}
      ariaLabelConfig={graphAriaLabels}>
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
    {!!selection.length && <div className="canvas-selection-actions">
      <button className="button primary" onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        openComposer(selection, { x: rect.left, y: rect.bottom })
      }}><MessageSquare size={14} />批注所选（{selection.length}）</button>
    </div>}
    {!!multiObjectComments.length && <nav className="canvas-comment-index" aria-label="多目标批注">
      {multiObjectComments.map(comment => <button key={comment.id} className={`button status-${comment.status}`}
        aria-label={`批注 ${review.comments.indexOf(comment) + 1}，涉及 ${comment.targets.length} 项`}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          onOpenThread(comment.id, { x: rect.right, y: rect.bottom })
        }}><MessageSquare size={13} />#{review.comments.indexOf(comment) + 1} · {comment.targets.length} 项</button>)}
    </nav>}
    {hasSceneDraft && <button className="button canvas-draft-indicator" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      openComposer(draftTargets, { x: rect.right, y: rect.bottom })
    }}><Pencil size={13} />继续草稿 · {draftTargets.length} 项</button>}
  </div>
})

export default GraphCanvas
