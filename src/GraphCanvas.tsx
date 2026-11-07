import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, Background, Controls, ControlButton, Handle, Position, SelectionMode,
  MarkerType, useNodesState, useEdgesState, useUpdateNodeInternals,
} from '@xyflow/react'
import type { EdgeChange, Node, NodeChange, NodeProps, OnSelectionChangeParams, ReactFlowInstance, Viewport } from '@xyflow/react'
import { Diamond, Flag, Focus, Info, LogOut, MessageSquare, Scan, Square, X } from 'lucide-react'
import type { ReviewChanges, ReviewComment, ReviewDocument, ReviewEdge, ReviewNode, Target } from './types.ts'
import { indexGraph, indexGraphComments, targetKey as keyOf } from './graph-index.ts'
import { layoutGraph } from './graph-layout.ts'
import { availableScopeNodeIds, comparisonLayout, graphBounds, relatedNodeIds } from './graph-focus.ts'
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
  onOpenInspection: (targets: Target[], point?: Point, tab?: 'comments' | 'detail') => void
  onOpenThread: (commentId: string, point?: Point, target?: Target) => void
  onViewportChange?: () => void
  readOnly?: boolean
  viewportKey?: string
  changeSide?: 'before' | 'after'
  commentOrder?: string[]
  flowPulse?: number
  onSelectIntent?: () => void
  onHoverIntent?: () => void
  comparisonReview?: ReviewDocument
  focusTargets?: Target[]
  readingScopeKey?: string
}

export interface GraphCanvasHandle {
  getTargetRect: (targets: Target[]) => TargetRect | null
  getCanvasRect: () => DOMRect | null
  focusTargets: (targets: Target[]) => void
  focusRelated: (targets: Target[]) => void
  revealTargets: (targets: Target[], bottom: number) => void
}

type FlowNode = Node<{
  item: ReviewNode
  count: number
  change?: ChangeKind
  layout: LayoutNode
  onComment: (target: Target, point: Point) => void
}, 'review'>

const kindLabels = { action: '操作', decision: '判断', result: '结果', failure: '失败出口' }
const kindIcons = { action: Square, decision: Diamond, result: Flag, failure: LogOut }
type ChangeKind = 'added' | 'changed' | 'removed' | 'evidence'
const changeLabels: Record<ChangeKind, string> = { added: '新增', changed: '已修改', removed: '已移除', evidence: '依据更新' }
const changeColors: Record<ChangeKind, string> = { added: 'var(--color-success)', changed: 'var(--color-warning)', removed: 'var(--color-error)', evidence: 'var(--color-accent)' }
const savedViewports = new Map<string, { viewport: Viewport; width: number }>()
const savedReadingScopes = new Map<string, string[]>()
const EMPTY_NODES: ReviewNode[] = []
const EMPTY_EDGES: ReviewEdge[] = []
const EMPTY_COMMENTS: ReviewComment[] = []

const portSides = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }

const ReviewNodeView = memo(function ReviewNodeView({ id, data }: NodeProps<FlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals()
  const frame = useRef(0)
  // CSS lift changes port coordinates without triggering a node resize.
  const followLift = () => {
    cancelAnimationFrame(frame.current)
    const until = performance.now() + 260
    const tick = () => {
      updateNodeInternals(id)
      if (performance.now() < until) frame.current = requestAnimationFrame(tick)
    }
    tick()
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const KindIcon = kindIcons[data.item.kind]
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => updateNodeInternals(id)
    reduced.addEventListener('change', update)
    return () => reduced.removeEventListener('change', update)
  }, [id, updateNodeInternals])
  return <div className={`review-node kind-${data.item.kind} ${data.count ? 'has-comment' : ''} ${data.change ? `revision-${data.change}` : ''}`}
    onPointerEnter={followLift} onPointerLeave={followLift} onPointerDown={followLift} onPointerUp={followLift}
    onTransitionRun={event => { if (event.nativeEvent.propertyName === 'transform' && event.target === event.currentTarget) followLift() }}>
    {data.layout.ports.map(port => <Handle key={port.id} id={port.id} type={port.type} position={portSides[port.side]}
      style={port.side === 'top' || port.side === 'bottom' ? { left: port.offset } : { top: port.offset }} />)}
    <div className="node-topline">
      <span className="node-kind"><KindIcon aria-hidden="true" />{kindLabels[data.item.kind]}</span>
      {data.change && <span className={`badge revision-badge revision-${data.change}`}>{changeLabels[data.change]}</span>}
      <button className={`node-comment-button nodrag nopan ${data.count ? '' : 'is-empty'}`}
        aria-label={`讨论：${data.item.title}${data.count ? `（${data.count} 条）` : ''}`} title="打开讨论、详情与代码对照" data-keep-composer
        onClick={event => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          data.onComment({ kind: 'node', id: data.item.id }, { x: rect.right, y: rect.bottom })
        }}><MessageSquare size={14} /><span>{data.count || '讨论'}</span></button>
    </div>
    <strong className="node-title">{data.item.title}</strong>
    <p className="node-summary">{data.item.summary}</p>
  </div>
})

const nodeTypes = { review: ReviewNodeView }
const edgeTypes = { review: GraphEdge }
function NodeMeasurements({ nodes, onReady }: { nodes: FlowNode[]; onReady: (nodes: FlowNode[]) => void }) {
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    if (!nodes.length) return
    // Measure committed handles together; per-node calls trigger a full layout for each node.
    updateNodeInternals(nodes.map(node => node.id))
    const frame = requestAnimationFrame(() => onReady(nodes))
    return () => cancelAnimationFrame(frame)
  }, [nodes, onReady, updateNodeInternals])
  return null
}
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
  onOpenComposer, onOpenInspection, onOpenThread, onViewportChange, readOnly = false,
  viewportKey, changeSide = 'after', commentOrder,
  flowPulse = 0, onSelectIntent, onHoverIntent, comparisonReview, focusTargets, readingScopeKey,
}, ref) {
  const [nodes, setNodes, applyNodeChanges] = useNodesState<FlowNode>([])
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<FlowEdge>([])
  const [readyHandles, setReadyHandles] = useState(new Map<string, ReadonlySet<string>>())
  const [nodeSizes, setNodeSizes] = useState(new Map<string, { width: number; height: number }>())
  const [readingNodeIds, setReadingNodeIds] = useState<string[] | null>(() => {
    const nodes = review.nodes.filter(node => node.sceneId === sceneId)
    const saved = readingScopeKey ? savedReadingScopes.get(readingScopeKey) : undefined
    if (saved) return availableScopeNodeIds(saved, nodes)
    return focusTargets?.length ? relatedNodeIds(nodes, review.edges.filter(edge => edge.sceneId === sceneId), focusTargets) : null
  })
  const readingNodeIdsRef = useRef(readingNodeIds)
  readingNodeIdsRef.current = readingNodeIds
  const completeViewport = useRef<{ viewport: Viewport; width: number } | null>(null)
  const pendingViewport = useRef<{ viewport: Viewport; width: number } | null>(null)
  const selectionRef = useRef(selection)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null)
  const marqueeRef = useRef(false)
  const layoutReady = useRef(false)
  const canvasSize = useRef({ width: 0, height: 0 })
  const layoutFrame = useRef(0)
  const pendingFocus = useRef<string[] | null>(null)
  const pendingElementFocus = useRef<string | null>(null)
  selectionRef.current = selection

  const graphIndex = useMemo(() => indexGraph(review.nodes, review.edges, review.scenes), [review.nodes, review.edges, review.scenes])
  const commentIndex = useMemo(() => indexGraphComments(review.comments, graphIndex.targetScenes), [review.comments, graphIndex])
  const sceneNodes = graphIndex.nodesByScene.get(sceneId) ?? EMPTY_NODES
  const sceneEdges = graphIndex.edgesByScene.get(sceneId) ?? EMPTY_EDGES
  const readingSet = useMemo(() => readingNodeIds ? new Set(readingNodeIds) : null, [readingNodeIds])
  const displayedNodes = useMemo(() => readingSet ? sceneNodes.filter(node => readingSet.has(node.id)) : sceneNodes, [sceneNodes, readingSet])
  const displayedEdges = useMemo(() => readingSet ? sceneEdges.filter(edge => readingSet.has(edge.source) && readingSet.has(edge.target)) : sceneEdges, [sceneEdges, readingSet])
  const boundaryEdges = useMemo(() => readingSet ? sceneEdges.filter(edge => readingSet.has(edge.source) !== readingSet.has(edge.target)) : [], [sceneEdges, readingSet])
  const displayedIds = useRef(new Set(displayedNodes.map(node => node.id)))
  displayedIds.current = new Set(displayedNodes.map(node => node.id))
  const comparisonKey = comparisonReview ? [review.snapshot.fingerprint, comparisonReview.snapshot.fingerprint].sort().join(':') : ''
  const savedViewportKey = viewportKey && comparisonKey ? `${viewportKey}:comparison:${comparisonKey}` : viewportKey
  const layout = useMemo(() => {
    if (!comparisonReview) return layoutGraph(displayedNodes, displayedEdges, nodeSizes)
    const sharedScope = readingScopeKey ? savedReadingScopes.get(readingScopeKey) : undefined
    const comparisonScope = readingSet && sharedScope ? new Set(sharedScope) : readingSet
    const referenceNodes = comparisonReview.nodes.filter(node => node.sceneId === sceneId && (!comparisonScope || comparisonScope.has(node.id)))
    const referenceIds = new Set(referenceNodes.map(node => node.id))
    const referenceEdges = comparisonReview.edges.filter(edge => edge.sceneId === sceneId && referenceIds.has(edge.source) && referenceIds.has(edge.target))
    return comparisonLayout(displayedNodes, displayedEdges, referenceNodes, referenceEdges, nodeSizes)
  }, [displayedNodes, displayedEdges, nodeSizes, comparisonReview, sceneId, readingSet, readingScopeKey])
  const layoutRef = useRef(layout)
  layoutRef.current = layout
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
    if (!savedViewportKey || !flow || !canvas || !layoutReady.current || readingNodeIdsRef.current) return
    savedViewports.delete(savedViewportKey)
    savedViewports.set(savedViewportKey, { viewport: flow.getViewport(), width: canvas.clientWidth })
    if (savedViewports.size > 200) savedViewports.delete(savedViewports.keys().next().value!)
  }, [savedViewportKey])

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

  const fitCompleteGraph = useCallback(() => {
    const flow = flowRef.current, canvas = canvasRef.current
    if (!flow || !canvas) return Promise.resolve(false)
    const bounds = graphBounds(layoutRef.current.nodes, layoutRef.current.edges)
    if (!bounds.width || !bounds.height) return Promise.resolve(false)
    const zoom = Math.max(.05, Math.min(.9, (canvas.clientWidth - 48) / bounds.width, (canvas.clientHeight - 48) / bounds.height))
    return flow.setViewport({ x: (canvas.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
      y: (canvas.clientHeight - bounds.height * zoom) / 2 - bounds.y * zoom, zoom }, { duration: 0 }).then(result => { saveViewport(); return result })
  }, [saveViewport])

  const updateLayout = useCallback(() => {
    const flow = flowRef.current
    const canvas = canvasRef.current
    if (!flow || !canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    const items = flow.getNodes()
    if (!layoutReady.current) {
      if (items.some(node => !node.measured?.width || !node.measured?.height)) return
      if (items.length !== displayedIds.current.size || items.some(node => !displayedIds.current.has(node.id))) return
      layoutReady.current = true
      canvasSize.current = { width, height }
      const markReady = () => {
        canvas.dataset.viewportReady = 'true'
        saveViewport()
        if (pendingElementFocus.current) {
          const selector = pendingElementFocus.current
          pendingElementFocus.current = null
          requestAnimationFrame(() => canvas.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }))
        }
      }
      if (!items.length) { markReady(); return }
      if (pendingViewport.current) {
        const saved = pendingViewport.current
        pendingViewport.current = null
        void flow.setViewport({ ...saved.viewport, x: saved.viewport.x + (width - saved.width) / 2 }, { duration: 0 }).then(markReady)
        return
      }
      if (readingNodeIdsRef.current) {
        const targets = pendingFocus.current ? items.filter(node => pendingFocus.current!.includes(node.id)) : items
        const bounds = flow.getNodesBounds(targets.length ? targets : items)
        const zoom = Math.max(.75, Math.min(.9, (width - 48) / bounds.width))
        void flow.setViewport({ x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: 128 - bounds.y * zoom, zoom }, { duration: 0 }).then(markReady)
        pendingFocus.current = null
        return
      }
      if (pendingFocus.current) {
        const focused = window.matchMedia('(max-width: 900px)').matches
          ? focusReading(pendingFocus.current)
          : flow.fitView({ nodes: pendingFocus.current.map(id => ({ id })), padding: 0.2, maxZoom: 0.9, duration: 0 })
        void focused.then(markReady)
        pendingFocus.current = null
        return
      }
      const saved = savedViewportKey ? savedViewports.get(savedViewportKey) : undefined
      if (saved) {
        void flow.setViewport({ ...saved.viewport, x: saved.viewport.x + (width - saved.width) / 2 }, { duration: 0 }).then(markReady)
        return
      }
      if (window.matchMedia('(max-width: 900px)').matches) {
        void focusReading([]).then(markReady)
        return
      }
      const bounds = graphBounds(layoutRef.current.nodes, layoutRef.current.edges)
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
  }, [savedViewportKey, saveViewport, focusReading])

  const scheduleLayout = useCallback(() => {
    cancelAnimationFrame(layoutFrame.current)
    layoutFrame.current = requestAnimationFrame(updateLayout)
  }, [updateLayout])

  useEffect(() => {
    layoutReady.current = false
    if (canvasRef.current) delete canvasRef.current.dataset.viewportReady
    scheduleLayout()
  }, [savedViewportKey, sceneId, scheduleLayout])

  const readingKey = readingNodeIds?.join('\u0000') ?? ''
  useEffect(() => {
    layoutReady.current = false
    if (canvasRef.current) delete canvasRef.current.dataset.viewportReady
    scheduleLayout()
  }, [readingKey, scheduleLayout])

  const focusRelated = useCallback((targets: Target[]) => {
    const ids = relatedNodeIds(sceneNodes, sceneEdges, targets)
    if (!ids.length) return
    if (!readingNodeIdsRef.current && flowRef.current && canvasRef.current) {
      completeViewport.current = { viewport: flowRef.current.getViewport(), width: canvasRef.current.clientWidth }
    }
    layoutReady.current = false
    canvasRef.current?.removeAttribute('data-viewport-ready')
    pendingElementFocus.current = '.canvas-focus-heading button'
    pendingFocus.current = targets.flatMap(target => {
      if (target.kind === 'node') return [target.id]
      const edge = target.kind === 'edge' ? graphIndex.edgesById.get(target.id) : undefined
      return edge ? [edge.source, edge.target] : []
    })
    if (readingScopeKey) {
      savedReadingScopes.delete(readingScopeKey)
      savedReadingScopes.set(readingScopeKey, ids)
      if (savedReadingScopes.size > 200) savedReadingScopes.delete(savedReadingScopes.keys().next().value!)
    }
    setReadingNodeIds(ids)
  }, [sceneNodes, sceneEdges, graphIndex, readingScopeKey])
  const showCompleteGraph = useCallback(() => {
    pendingViewport.current = completeViewport.current
    completeViewport.current = null
    pendingFocus.current = null
    layoutReady.current = false
    canvasRef.current?.removeAttribute('data-viewport-ready')
    pendingElementFocus.current = '.focus-related, .reading-view-control'
    if (readingScopeKey) savedReadingScopes.delete(readingScopeKey)
    setReadingNodeIds(null)
  }, [readingScopeKey])
  const externalFocusKey = focusTargets?.map(keyOf).sort().join('\u0000')
  const previousExternalFocus = useRef(externalFocusKey)
  useEffect(() => {
    if (externalFocusKey === previousExternalFocus.current) return
    previousExternalFocus.current = externalFocusKey
    if (focusTargets === undefined) return
    if (focusTargets.length) focusRelated(focusTargets)
    else showCompleteGraph()
  }, [externalFocusKey, focusRelated, showCompleteGraph, focusTargets])

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
    else onOpenInspection([target], point)
  }, [commentIndex, onOpenThread, onOpenInspection])

  const openContextComment = useCallback((target: Target, point: Point) => {
    if (readOnly) openNodeComment(target, point)
    else openComposer([target], point)
  }, [readOnly, openNodeComment, openComposer])

  const onPortsReady = useCallback((nodes: FlowNode[]) => {
    setReadyHandles(previous => {
      let next = previous
      for (const node of nodes) {
        const prior = previous.get(node.id)
        const handles = node.data.layout.ports.map(port => port.id)
        if (handles.every(handle => prior?.has(handle))) continue
        if (next === previous) next = new Map(previous)
        next.set(node.id, new Set([...(prior ?? []), ...handles]))
      }
      return next
    })
  }, [])

  useEffect(() => {
    const selected = new Set(selectionRef.current.map(keyOf))
    setNodes(previous => {
      // Keep measurements so updating a thread doesn't hide its node and drop keyboard focus.
      const prior = new Map(previous.map(node => [node.id, node]))
      return displayedNodes.map(item => {
        const key = `node:${item.id}`
        const change = targetChanges.get(key)
        const placed = layout.nodes.get(item.id)!
        // React Flow replaces its edge store after the new handle DOM is committed.
        const ports = new Map(prior.get(item.id)?.data.layout.ports.map(port => [port.id, port]))
        placed.ports.forEach(port => ports.set(port.id, port))
        return {
          ...prior.get(item.id),
          id: item.id, type: 'review', position: layout.nodes.get(item.id)!.position, ariaLabel: `${item.title}${change ? `，${changeLabels[change]}` : ''}`,
          selected: selected.has(key),
          data: {
            item,
            count: commentIndex.counts.get(key) ?? 0,
            change,
            layout: { ...placed, ports: [...ports.values()] }, onComment: openNodeComment,
          },
        }
      })
    })
    setEdges(displayedEdges.map(item => {
      const key = `edge:${item.id}`
      const change = targetChanges.get(key)
      const route = layout.edges.get(item.id)!
      return {
        id: item.id, source: item.source, target: item.target,
        sourceHandle: route.sourceHandle, targetHandle: route.targetHandle,
        data: { route, status: [change ? changeLabels[change] : '', commentIndex.counts.has(key) ? '有批注' : ''].filter(Boolean).join(' · ') },
        label: item.label,
        type: 'review', ariaLabel: `${graphIndex.nodesById.get(item.source)?.title ?? `已移除节点 · ${item.source}`}：${item.label}${change ? `，${changeLabels[change]}` : ''}`,
        selected: selected.has(key),
        className: [change ? `revision-${change}` : '', route.kind ? `route-${route.kind}` : ''].filter(Boolean).join(' ') || undefined,
        style: change ? { stroke: changeColors[change] } : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, ...(change ? { color: changeColors[change] } : {}) }, interactionWidth: 28,
      }
    }))
  }, [displayedNodes, displayedEdges, layout, graphIndex, commentIndex, targetChanges, readOnly, setNodes, setEdges, openNodeComment, onOpenInspection])

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
  const visibleEdges = useMemo(() => edges.filter(edge => readyHandles.get(edge.source)?.has(edge.sourceHandle!)
    && readyHandles.get(edge.target)?.has(edge.targetHandle!)).map(edge => {
    const relation: FlowRelation | undefined = focusedEdges.has(edge.id) ? 'selected'
      : focusedNodes.has(edge.source) ? 'outgoing' : focusedNodes.has(edge.target) ? 'incoming' : undefined
    return {
      ...edge,
      className: `${edge.className ?? ''}${relation ? ` is-related flow-${relation}` : hasFocus ? ' is-unrelated' : ''}`,
      zIndex: relation ? 2 : 0,
      data: { ...edge.data!, relation, pulse: flowPulse },
      ...(relation ? { style: { ...edge.style, stroke: relationColors[relation] }, markerEnd: { type: MarkerType.ArrowClosed, color: relationColors[relation] } } : {}),
    }
  }), [edges, readyHandles, focusedNodes, focusedEdges, hasFocus, flowPulse])

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
      ...selectionRef.current.filter(target => readingNodeIdsRef.current && (target.kind === 'node'
        ? !readingNodeIdsRef.current.includes(target.id)
        : target.kind === 'edge' && !selectedEdges.some(edge => edge.id === target.id) && !flowRef.current?.getEdge(target.id))),
      ...selectedNodes.map(node => ({ kind: 'node' as const, id: node.id })),
      ...selectedEdges.map(edge => ({ kind: 'edge' as const, id: edge.id })),
    ]
    if (JSON.stringify(next.map(keyOf).sort()) !== JSON.stringify(selectionRef.current.map(keyOf).sort())) setSelection(next)
  }, [setSelection])

  const getTargetRect = useCallback((targets: Target[]) => {
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
  }, [])
  useImperativeHandle(ref, () => ({
    getCanvasRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    getTargetRect,
    focusRelated,
    revealTargets: (targets, bottom) => {
      const rect = getTargetRect(targets)
      const canvas = canvasRef.current?.getBoundingClientRect()
      const flow = flowRef.current
      if (!rect || !canvas || !flow || !layoutReady.current) return
      const top = canvas.top + 12
      const dy = rect.top < top ? top - rect.top : rect.bottom > bottom - 12 ? Math.max(top - rect.top, bottom - 12 - rect.bottom) : 0
      if (dy) { const viewport = flow.getViewport(); void flow.setViewport({ ...viewport, y: viewport.y + dy }, { duration: 0 }).then(saveViewport) }
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
        if (readingNodeIdsRef.current && [...nodeIds].some(id => !readingNodeIdsRef.current!.includes(id))) {
          layoutReady.current = false
          canvasRef.current?.removeAttribute('data-viewport-ready')
          pendingFocus.current = [...nodeIds]
          setReadingNodeIds(current => [...new Set([...(current ?? []), ...nodeIds])])
          return
        }
        if (layoutReady.current) {
          if (window.matchMedia('(max-width: 900px)').matches) void focusReading([...nodeIds])
          else void flowRef.current?.fitView({ nodes: [...nodeIds].map(id => ({ id })), padding: 0.2, maxZoom: 0.9, duration: 0 })
        }
        else { pendingFocus.current = [...nodeIds]; scheduleLayout() }
      }
    },
  }), [graphIndex, sceneId, sceneNodes, scheduleLayout, focusReading, getTargetRect, saveViewport, focusRelated])

  return <div ref={canvasRef} className={`canvas${readOnly ? ' is-readonly' : ''}`} aria-label="业务流程画布" data-node-appearance={nodeAppearance} data-readonly={readOnly || undefined} data-reading-focus={readingNodeIds ? 'related' : undefined} onPointerCancelCapture={() => { marqueeRef.current = false }}
    onKeyDownCapture={event => { if ((event.key === 'Enter' || event.key === ' ') && (event.target as Element).matches('.react-flow__node, .react-flow__edge')) onSelectIntent?.() }}>
    <ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="system"
      onInit={instance => { flowRef.current = instance; scheduleLayout() }} onMove={() => { saveViewport(); onViewportChange?.() }}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={onSelectionChange}
      onNodeClick={event => { if (!(event.target as Element).closest('button')) onSelectIntent?.() }} onEdgeClick={() => onSelectIntent?.()}
      onNodeMouseEnter={(_, node) => { if (node.selected) onHoverIntent?.() }}
      onSelectionStart={() => { marqueeRef.current = true }} onSelectionEnd={() => { marqueeRef.current = false }}
      onNodeContextMenu={(event, node) => { event.preventDefault(); openContextComment({ kind: 'node', id: node.id }, { x: event.clientX, y: event.clientY }) }}
      onEdgeContextMenu={(event, edge) => { event.preventDefault(); openContextComment({ kind: 'edge', id: edge.id }, { x: event.clientX, y: event.clientY }) }}
      onEdgeDoubleClick={(event, edge) => openContextComment({ kind: 'edge', id: edge.id }, { x: event.clientX, y: event.clientY })}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      selectionOnDrag={mode === 'select'} selectionKeyCode={null} selectionMode={SelectionMode.Partial}
      panOnDrag={mode === 'pan' ? [0, 1, 2] : [1, 2]} multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
      panOnScroll zoomOnScroll={false} zoomActivationKeyCode={['Control', 'Meta']}
      defaultViewport={{ x: 36, y: 32, zoom: 0.85 }} minZoom={0.05} maxZoom={1.6}
      ariaLabelConfig={readingNodeIds ? { ...graphAriaLabels, 'controls.fitView.ariaLabel': '显示关联流程总览' } : graphAriaLabels}>
      <NodeMeasurements nodes={nodes} onReady={onPortsReady} />
      <Background gap={24} size={1} />
      <Controls showInteractive={false} showFitView={false}>
        <ControlButton className="react-flow__controls-fitview" aria-label={readingNodeIds ? '显示关联流程总览' : '显示完整流程'} title={readingNodeIds ? '显示关联流程总览' : '显示完整流程'} onClick={() => void fitCompleteGraph()}><Scan size={14} /></ControlButton>
        <ControlButton className="reading-view-control" aria-label="恢复阅读视图" title="恢复阅读视图" onClick={() => void focusReading()}>阅读</ControlButton>
      </Controls>
    </ReactFlow>
    <GraphLegend nodeAppearance={nodeAppearance} onNodeAppearanceChange={onNodeAppearanceChange} />
    {readingNodeIds && <div className="canvas-focus-controls" data-keep-composer>
      <div className="canvas-focus-heading"><button className="button" onClick={showCompleteGraph}>返回完整图</button><span>关联流程 · {displayedNodes.length}/{sceneNodes.length} 个步骤</span></div>
      {!displayedNodes.length && <p className="canvas-focus-empty">当前版本中没有这个范围的步骤。</p>}
      {!!boundaryEdges.length && <details className="canvas-boundary-connections"><summary className="button">跨范围连接（{boundaryEdges.length}）</summary><div className="canvas-boundary-list">
        {boundaryEdges.map(edge => <article key={edge.id} data-edge-id={edge.id}>
          <strong>{edge.label || '继续'}</strong><p>{graphIndex.nodesById.get(edge.source)?.title} → {graphIndex.nodesById.get(edge.target)?.title}</p>
          {edge.detail && <p>{edge.detail}</p>}
          <div className="tool-group"><button className="button" aria-label={`展开并定位连接：${edge.label || edge.id}`} onClick={() => {
            layoutReady.current = false
            canvasRef.current?.removeAttribute('data-viewport-ready')
            pendingElementFocus.current = `.react-flow__edge[data-id="${CSS.escape(edge.id)}"]`
            pendingFocus.current = [edge.source, edge.target]
            const ids = [...new Set([...(readingNodeIdsRef.current ?? []), edge.source, edge.target])]
            if (readingScopeKey) {
              const shared = savedReadingScopes.get(readingScopeKey) ?? []
              savedReadingScopes.delete(readingScopeKey)
              savedReadingScopes.set(readingScopeKey, [...new Set([...shared, ...ids])])
              if (savedReadingScopes.size > 200) savedReadingScopes.delete(savedReadingScopes.keys().next().value!)
            }
            setReadingNodeIds(ids)
            setSelection([{ kind: 'edge', id: edge.id }])
            onSelectIntent?.()
          }}>展开并定位</button>
          {(!readOnly || commentIndex.counts.has(`edge:${edge.id}`)) && <button className="button" aria-label={`批注连接：${edge.label || edge.id}`} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            openNodeComment({ kind: 'edge', id: edge.id }, { x: rect.right, y: rect.bottom })
          }}>批注</button>}</div>
        </article>)}
      </div></details>}
    </div>}
    {!!selection.length && <div className={`canvas-selection-actions${selection.length === 1 && selection[0].kind === 'node' ? ' is-single-node' : ''}`}>
      {(selection.length > 1 || selection[0].kind === 'edge') && <button className="button" data-keep-composer onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        onOpenInspection(selection, { x: rect.left, y: rect.bottom }, 'detail')
      }}><Info size={14} />查看详情</button>}
      {!readingNodeIds && <button className="button focus-related" data-keep-composer onClick={() => focusRelated(selection)}><Focus size={14} />聚焦关联流程</button>}
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
