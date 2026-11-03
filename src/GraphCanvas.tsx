import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, Background, Controls, ControlButton, Handle, Position, SelectionMode,
  MarkerType, useNodesState, useEdgesState, useUpdateNodeInternals,
} from '@xyflow/react'
import type { EdgeChange, Node, NodeChange, NodeProps, OnSelectionChangeParams, ReactFlowInstance, Viewport } from '@xyflow/react'
import { Diamond, Flag, LogOut, MessageSquare, Square, X } from 'lucide-react'
import type { ReviewChanges, ReviewComment, ReviewDocument, ReviewEdge, ReviewNode, Target } from './types.ts'
import { indexGraph, indexGraphComments, targetKey as keyOf } from './graph-index.ts'
import { layoutGraph } from './graph-layout.ts'
import type { LayoutNode } from './graph-layout.ts'
import GraphEdge, { relationColors } from './GraphEdge.tsx'
import type { FlowEdge, FlowRelation } from './GraphEdge.tsx'
import GraphLegend from './GraphLegend.tsx'
import type { NodeAppearance } from './GraphLegend.tsx'

type Point = { x: number; y: number }
type TargetRect = { left: number; right: number; top: number; bottom: number }

export interface GraphCanvasProps {
  review: ReviewDocument
  sceneId: string
  selection: Target[]
  setSelection: (targets: Target[]) => void
  changes: ReviewChanges & { evidenceChanged?: Target[] }
  mode: 'pan' | 'select'
  nodeAppearance: NodeAppearance
  onNodeAppearanceChange: (appearance: NodeAppearance) => void
  onOpenComposer: (targets: Target[], point?: Point) => void
  onOpenThread: (commentId: string, point?: Point, target?: Target) => void
  onViewportChange?: () => void
  readOnly?: boolean
  viewportKey?: string
  changeSide?: 'before' | 'after'
  commentOrder?: string[]
}

export interface GraphCanvasHandle {
  getTargetRect: (targets: Target[]) => TargetRect | null
  getCanvasRect: () => DOMRect | null
  focusTargets: (targets: Target[]) => void
}

type FlowNode = Node<{
  item: ReviewNode
  count: number
  change?: ChangeKind
  readOnly: boolean
  layout: LayoutNode
  onComment: (target: Target, point: Point) => void
}, 'review'>

const kindLabels = { action: '操作', decision: '判断', result: '结果', failure: '失败出口' }
const kindIcons = { action: Square, decision: Diamond, result: Flag, failure: LogOut }
type ChangeKind = 'added' | 'changed' | 'removed' | 'evidence'
const changeLabels: Record<ChangeKind, string> = { added: '新增', changed: '已修改', removed: '已移除', evidence: '依据更新' }
const changeColors: Record<ChangeKind, string> = { added: 'var(--color-success)', changed: 'var(--color-warning)', removed: 'var(--color-error)', evidence: 'var(--color-accent)' }
const savedViewports = new Map<string, { viewport: Viewport; width: number }>()
const EMPTY_NODES: ReviewNode[] = []
const EMPTY_EDGES: ReviewEdge[] = []
const EMPTY_COMMENTS: ReviewComment[] = []

const portSides = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }

const ReviewNodeView = memo(function ReviewNodeView({ id, data }: NodeProps<FlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals()
  const KindIcon = kindIcons[data.item.kind]
  useEffect(() => { updateNodeInternals(id) }, [id, data.layout.ports, updateNodeInternals])
  return <div className={`review-node kind-${data.item.kind} ${data.count ? 'has-comment' : ''} ${data.change ? `revision-${data.change}` : ''}`}>
    {data.layout.ports.map(port => <Handle key={port.id} id={port.id} type={port.type} position={portSides[port.side]}
      style={port.side === 'top' || port.side === 'bottom' ? { left: port.offset } : { top: port.offset }} />)}
    <div className="node-topline">
      <span className="node-kind"><KindIcon aria-hidden="true" />{kindLabels[data.item.kind]}</span>
      {data.change && <span className={`badge revision-badge revision-${data.change}`}>{changeLabels[data.change]}</span>}
      {(!data.readOnly || data.count > 0) && <button className={`node-comment-button nodrag nopan ${data.count ? '' : 'is-empty'}`}
        aria-label={`批注：${data.item.title}${data.count ? `（${data.count} 条）` : ''}`}
        onClick={event => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          data.onComment({ kind: 'node', id: data.item.id }, { x: rect.right, y: rect.bottom })
        }}>
        <MessageSquare size={13} /><span>{data.count || '批注'}</span>
      </button>}
    </div>
    <strong className="node-title">{data.item.title}</strong>
    <p className="node-summary">{data.item.summary}</p>
  </div>
})

const nodeTypes = { review: ReviewNodeView }
const edgeTypes = { review: GraphEdge }
const graphAriaLabels = {
  'controls.zoomIn.ariaLabel': '放大流程',
  'controls.zoomOut.ariaLabel': '缩小流程',
  'controls.fitView.ariaLabel': '显示完整流程',
  'node.a11yDescription.default': '按回车或空格选择步骤。按住 Shift 可多选。',
  'edge.a11yDescription.default': '按回车或空格选择连线。按住 Shift 可多选。',
}

const GraphCanvas = memo(forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas({
  review, sceneId, selection, setSelection, changes, mode,
  nodeAppearance, onNodeAppearanceChange,
  onOpenComposer, onOpenThread, onViewportChange, readOnly = false,
  viewportKey, changeSide = 'after', commentOrder,
}, ref) {
  const [nodes, setNodes, applyNodeChanges] = useNodesState<FlowNode>([])
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<FlowEdge>([])
  const [nodeSizes, setNodeSizes] = useState(new Map<string, { width: number; height: number }>())
  const selectionRef = useRef(selection)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null)
  const marqueeRef = useRef(false)
  const layoutReady = useRef(false)
  const canvasSize = useRef({ width: 0, height: 0 })
  const layoutFrame = useRef(0)
  const pendingFocus = useRef<string[] | null>(null)
  selectionRef.current = selection

  const graphIndex = useMemo(() => indexGraph(review.nodes, review.edges, review.scenes), [review.nodes, review.edges, review.scenes])
  const commentIndex = useMemo(() => indexGraphComments(review.comments, graphIndex.targetScenes), [review.comments, graphIndex])
  const sceneNodes = graphIndex.nodesByScene.get(sceneId) ?? EMPTY_NODES
  const sceneEdges = graphIndex.edgesByScene.get(sceneId) ?? EMPTY_EDGES
  const layout = useMemo(() => layoutGraph(sceneNodes, sceneEdges, nodeSizes), [sceneNodes, sceneEdges, nodeSizes])
  const multiObjectComments = commentIndex.multiObjectByScene.get(sceneId) ?? EMPTY_COMMENTS
  const commentNumbers = useMemo(() => commentOrder
    ? new Map(commentOrder.map((id, index) => [id, index + 1])) : commentIndex.numbers, [commentOrder, commentIndex])
  const targetChanges = useMemo(() => {
    const result = new Map<string, ChangeKind>()
    for (const target of changes.evidenceChanged ?? []) result.set(keyOf(target), 'evidence')
    for (const target of changes.changed) result.set(keyOf(target), 'changed')
    for (const target of changeSide === 'after' ? changes.added : changes.removed) result.set(keyOf(target), changeSide === 'after' ? 'added' : 'removed')
    return result
  }, [changes.evidenceChanged, changes.changed, changes.added, changes.removed, changeSide])

  const saveViewport = useCallback(() => {
    const flow = flowRef.current
    const canvas = canvasRef.current
    if (!viewportKey || !flow || !canvas || !layoutReady.current) return
    savedViewports.delete(viewportKey)
    savedViewports.set(viewportKey, { viewport: flow.getViewport(), width: canvas.clientWidth })
    if (savedViewports.size > 200) savedViewports.delete(savedViewports.keys().next().value!)
  }, [viewportKey])

  const focusReading = useCallback((nodeIds?: string[]) => {
    const flow = flowRef.current
    const canvas = canvasRef.current
    if (!flow || !canvas) return Promise.resolve(false)
    const ids = nodeIds ?? selectionRef.current.flatMap(target => {
      if (target.kind === 'node') return [target.id]
      const edge = target.kind === 'edge' ? flow.getEdge(target.id) : undefined
      return edge ? [edge.source, edge.target] : []
    })
    const items = flow.getNodes()
    const targets = items.filter(node => ids.includes(node.id))
    const anchor = (targets.length ? targets : items).reduce<FlowNode | undefined>((first, node) =>
      !first || node.position.y < first.position.y ? node : first, undefined)
    if (!anchor) return Promise.resolve(false)
    const bounds = flow.getNodesBounds([anchor])
    return flow.setViewport({ x: (canvas.clientWidth - bounds.width) / 2 - bounds.x, y: 24 - bounds.y, zoom: 1 }, { duration: 0 })
  }, [])

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
      const markReady = () => { canvas.dataset.viewportReady = 'true'; saveViewport() }
      if (pendingFocus.current) {
        const focused = window.matchMedia('(max-width: 900px)').matches
          ? focusReading(pendingFocus.current)
          : flow.fitView({ nodes: pendingFocus.current.map(id => ({ id })), padding: 0.2, maxZoom: 0.9, duration: 0 })
        void focused.then(markReady)
        pendingFocus.current = null
        return
      }
      const saved = viewportKey ? savedViewports.get(viewportKey) : undefined
      if (saved) {
        void flow.setViewport({ ...saved.viewport, x: saved.viewport.x + (width - saved.width) / 2 }, { duration: 0 }).then(markReady)
        return
      }
      if (window.matchMedia('(max-width: 900px)').matches) {
        void focusReading([]).then(markReady)
        return
      }
      const bounds = flow.getNodesBounds(items)
      const zoom = Math.max(0.05, Math.min(0.85, (width - 48) / bounds.width))
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
    void flow.setViewport({ x, y, zoom: viewport.zoom }, { duration: 0 }).then(saveViewport)
  }, [viewportKey, saveViewport, focusReading])

  const scheduleLayout = useCallback(() => {
    cancelAnimationFrame(layoutFrame.current)
    layoutFrame.current = requestAnimationFrame(updateLayout)
  }, [updateLayout])

  useEffect(() => {
    layoutReady.current = false
    if (canvasRef.current) delete canvasRef.current.dataset.viewportReady
    scheduleLayout()
  }, [viewportKey, sceneId, scheduleLayout])

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
    if (readOnly) return
    setSelection(targets)
    onOpenComposer(targets, point)
  }, [readOnly, setSelection, onOpenComposer])

  const openNodeComment = useCallback((target: Target, point: Point) => {
    const latest = commentIndex.latest.get(keyOf(target))
    if (latest) onOpenThread(latest, point, target)
    else openComposer([target], point)
  }, [commentIndex, onOpenThread, openComposer])

  const openContextComment = useCallback((target: Target, point: Point) => {
    if (readOnly) openNodeComment(target, point)
    else openComposer([target], point)
  }, [readOnly, openNodeComment, openComposer])

  useEffect(() => {
    const selected = new Set(selectionRef.current.map(keyOf))
    setNodes(previous => {
      // Keep measurements so updating a thread doesn't hide its node and drop keyboard focus.
      const prior = new Map(previous.map(node => [node.id, node]))
      return sceneNodes.map(item => {
        const key = `node:${item.id}`
        const change = targetChanges.get(key)
        return {
          ...prior.get(item.id),
          id: item.id, type: 'review', position: layout.nodes.get(item.id)!.position, ariaLabel: `${item.title}${change ? `，${changeLabels[change]}` : ''}`,
          selected: selected.has(key),
          data: {
            item,
            count: commentIndex.counts.get(key) ?? 0,
            change, readOnly,
            layout: layout.nodes.get(item.id)!, onComment: openNodeComment,
          },
        }
      })
    })
    setEdges(sceneEdges.map(item => {
      const key = `edge:${item.id}`
      const change = targetChanges.get(key)
      const route = layout.edges.get(item.id)!
      return {
        id: item.id, source: item.source, target: item.target,
        sourceHandle: route.sourceHandle, targetHandle: route.targetHandle, data: { route },
        label: `${item.label}${change ? ` · ${changeLabels[change]}` : ''}${commentIndex.counts.has(key) ? ' · 有批注' : ''}`,
        type: 'review', ariaLabel: `${graphIndex.nodesById.get(item.source)?.title ?? `已移除节点 · ${item.source}`}：${item.label}${change ? `，${changeLabels[change]}` : ''}`,
        selected: selected.has(key),
        className: change ? `revision-${change}` : undefined,
        style: change ? { stroke: changeColors[change], strokeWidth: 2 } : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, ...(change ? { color: changeColors[change] } : {}) }, interactionWidth: 28,
      }
    }))
  }, [sceneNodes, sceneEdges, layout, graphIndex, commentIndex, targetChanges, readOnly, setNodes, setEdges, openNodeComment])

  useEffect(() => {
    const selected = new Set(selection.map(keyOf))
    setNodes(items => {
      const next = items.map(node => !!node.selected === selected.has(`node:${node.id}`) ? node : { ...node, selected: selected.has(`node:${node.id}`) })
      return next.some((node, index) => node !== items[index]) ? next : items
    })
    setEdges(items => {
      const next = items.map(edge => !!edge.selected === selected.has(`edge:${edge.id}`) ? edge : { ...edge, selected: selected.has(`edge:${edge.id}`) })
      return next.some((edge, index) => edge !== items[index]) ? next : items
    })
  }, [selection, setNodes, setEdges])

  const focusedNodes = useMemo(() => new Set(selection.filter(target => target.kind === 'node').map(target => target.id)), [selection])
  const focusedEdges = useMemo(() => new Set(selection.filter(target => target.kind === 'edge').map(target => target.id)), [selection])
  const hasFocus = focusedNodes.size > 0 || focusedEdges.size > 0
  const visibleEdges = useMemo(() => edges.map(edge => {
    const relation: FlowRelation | undefined = focusedEdges.has(edge.id) ? 'selected'
      : focusedNodes.has(edge.source) ? 'outgoing' : focusedNodes.has(edge.target) ? 'incoming' : undefined
    return {
      ...edge,
      className: `${edge.className ?? ''}${relation ? ` is-related flow-${relation}` : hasFocus ? ' is-unrelated' : ''}`,
      zIndex: relation ? 2 : 0,
      data: { ...edge.data!, relation },
      ...(relation ? { style: { ...edge.style, stroke: relationColors[relation] }, markerEnd: { type: MarkerType.ArrowClosed, color: relationColors[relation] } } : {}),
    }
  }), [edges, focusedNodes, focusedEdges, hasFocus])

  const onNodesChange = useCallback((nodeChanges: NodeChange<FlowNode>[]) => {
    applyNodeChanges(nodeChanges)
    const dimensions = nodeChanges.filter(change => change.type === 'dimensions' && change.dimensions)
    if (!dimensions.length) return
    setNodeSizes(previous => {
      const next = new Map(previous)
      let changed = false
      for (const change of dimensions) {
        if (change.type !== 'dimensions' || !change.dimensions) continue
        const prior = previous.get(change.id)
        if (prior?.width === change.dimensions.width && prior?.height === change.dimensions.height) continue
        next.set(change.id, change.dimensions)
        changed = true
      }
      return changed ? next : previous
    })
  }, [applyNodeChanges])

  const onEdgesChange = useCallback((edgeChanges: EdgeChange<FlowEdge>[]) => {
    // React Flow includes connected edges in a marquee. Keep edges an explicit selection.
    applyEdgeChanges(marqueeRef.current
      ? edgeChanges.filter(change => change.type !== 'select' || !change.selected)
      : edgeChanges)
  }, [applyEdgeChanges])

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
    // React Flow emits an empty selection before a remounted graph has received its nodes.
    if (!layoutReady.current) return
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
          if (graphIndex.targetScenes.get(keyOf(target)) !== sceneId) return
          if (target.kind === 'node') nodeIds.add(target.id)
          if (target.kind === 'edge') {
            const edge = graphIndex.edgesById.get(target.id)
            if (edge) { nodeIds.add(edge.source); nodeIds.add(edge.target) }
          }
        })
      }
      if (nodeIds.size) {
        if (layoutReady.current) {
          if (window.matchMedia('(max-width: 900px)').matches) void focusReading([...nodeIds])
          else void flowRef.current?.fitView({ nodes: [...nodeIds].map(id => ({ id })), padding: 0.2, maxZoom: 0.9, duration: 0 })
        }
        else { pendingFocus.current = [...nodeIds]; scheduleLayout() }
      }
    },
  }), [graphIndex, sceneId, sceneNodes, scheduleLayout, focusReading])

  return <div ref={canvasRef} className={`canvas${readOnly ? ' is-readonly' : ''}`} aria-label="业务流程画布" data-node-appearance={nodeAppearance} data-readonly={readOnly || undefined} onPointerCancelCapture={() => { marqueeRef.current = false }}>
    <ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="system"
      onInit={instance => { flowRef.current = instance; scheduleLayout() }} onMove={() => { saveViewport(); onViewportChange?.() }}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={onSelectionChange}
      onSelectionStart={() => { marqueeRef.current = true }} onSelectionEnd={() => { marqueeRef.current = false }}
      onNodeContextMenu={(event, node) => { event.preventDefault(); openContextComment({ kind: 'node', id: node.id }, { x: event.clientX, y: event.clientY }) }}
      onEdgeContextMenu={(event, edge) => { event.preventDefault(); openContextComment({ kind: 'edge', id: edge.id }, { x: event.clientX, y: event.clientY }) }}
      onEdgeDoubleClick={(event, edge) => openContextComment({ kind: 'edge', id: edge.id }, { x: event.clientX, y: event.clientY })}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      selectionOnDrag={mode === 'select'} selectionKeyCode={null} selectionMode={SelectionMode.Partial}
      panOnDrag={mode === 'pan' ? [0, 1, 2] : [1, 2]} multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
      defaultViewport={{ x: 36, y: 32, zoom: 0.85 }} minZoom={0.05} maxZoom={1.6}
      ariaLabelConfig={graphAriaLabels}>
      <Background gap={24} size={1} />
      <Controls showInteractive={false}>
        <ControlButton className="reading-view-control" aria-label="恢复阅读视图" title="恢复阅读视图" onClick={() => void focusReading()}>阅读</ControlButton>
      </Controls>
    </ReactFlow>
    <GraphLegend nodeAppearance={nodeAppearance} onNodeAppearanceChange={onNodeAppearanceChange} />
    {!!selection.length && <div className={`canvas-selection-actions${selection.length === 1 && selection[0].kind === 'node' ? ' is-single-node' : ''}`}>
      {!readOnly && (selection.length > 1 || selection.some(target => target.kind === 'edge')) && <button className="button primary" onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        openComposer(selection, { x: rect.left, y: rect.bottom })
      }}><MessageSquare size={14} />批注所选（{selection.length}）</button>}
      <button className="button icon-button clear-selection" aria-label="清除选择" title="清除选择" onClick={() => setSelection([])}><X size={14} /></button>
    </div>}
    {!!multiObjectComments.length && <nav className="canvas-comment-index" aria-label="多目标批注">
      {multiObjectComments.map(comment => <button key={comment.id} className={`button status-${comment.status}`}
        aria-label={`批注 ${commentNumbers.get(comment.id)}，涉及 ${comment.targets.length} 项`}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          onOpenThread(comment.id, { x: rect.right, y: rect.bottom })
        }}><MessageSquare size={13} />#{commentNumbers.get(comment.id)} · {comment.targets.length} 项</button>)}
    </nav>}
  </div>
}))

export default GraphCanvas
