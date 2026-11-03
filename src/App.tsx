import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ChevronRight, Circle, Focus, GitBranch, Hand, Info, Maximize2, MessageSquare, MousePointer2, PanelLeftClose, PanelLeftOpen, Scan, ShieldCheck, Upload, X } from 'lucide-react'
import type { CommentDraft, CommentStatus, ReviewChanges, ReviewDocument, ReviewRecord, Target } from './types.ts'
import { addComment, addReply, getChanges, parseReview, rebaseReview, serializeReview, setCommentStatus, targetExists, targetLabel, targetSceneId } from './model.ts'
import { createApprovalRecord, createFeedbackPackage, draftKey, makeDraft, parseDrafts, parseRecordHistory, parseReviewRecord, pendingFeedback, withDraft } from './workspace.ts'
import GraphCanvas from './GraphCanvas.tsx'
import type { GraphCanvasHandle } from './GraphCanvas.tsx'
import CommentComposer from './CommentComposer.tsx'
import { sampleReview } from './sample.ts'
import { useReviewSession } from './useReviewSession.ts'
import type { CurrentSession } from './session-types.ts'
import { getRevisionChanges } from './revisions.ts'
import { currentPendingFeedback, recordRequest, sessionRequest } from './session-client.ts'
import RevisionControls, { RevisionChangesPanel } from './RevisionControls.tsx'
import CommentThreads from './CommentThreads.tsx'

const SESSION_ID = new URLSearchParams(window.location.search).get('session')
const STORAGE_PREFIX = 'logic-margin:review:'
const ACTIVE_KEY = 'logic-margin:active'
const DRAFTS_KEY = SESSION_ID ? `logic-margin:session:${SESSION_ID}:drafts` : 'logic-margin:drafts'
const HISTORY_KEY = 'logic-margin:record-history'
const SPIRIT_SANCTUM_PATH = '/reviews/spirit-sanctum.logic-margin.json'
const HAS_BUNDLED_SPIRIT_REVIEW = import.meta.env.VITE_LOGIC_MARGIN_PACKAGED !== 'true'
const EMPTY_CHANGES: ReviewChanges = { added: [], changed: [], removed: [] }
const EMPTY_TARGETS: Target[] = []
const statusLabels: Record<CommentStatus, string> = { open: '待处理', resolved: '已确认解决', 'needs-review': '待复核' }
const kindLabels = { action: '操作', decision: '判断', result: '结果', failure: '失败出口' }
const phaseLabels = { 'awaiting-review': '等待你评审', 'feedback-ready': '本轮已提交，等待代理接收', 'agent-working': '代理已接收意见', approved: '本轮已通过' }
const keyOf = (target: Target) => `${target.kind}:${target.id}`
const filename = (name: string) => name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 150)

function download(text: string, name: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function readCache<T>(key: string, parse: (value: unknown) => T, fallback: T) {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
    return { value: raw === null ? fallback : parse(JSON.parse(raw)), recovery: null as string | null, error: '' }
  } catch (error) {
    return { value: fallback, recovery: raw, error: error instanceof Error ? error.message : '存储不可用' }
  }
}

function closeMenus() {
  document.querySelectorAll<HTMLDetailsElement>('details.workspace-menu[open]').forEach(menu => { menu.open = false })
}

function readWorkspace() {
  let activeId = sampleReview.id
  try { activeId = localStorage.getItem(ACTIVE_KEY) ?? activeId } catch { /* readCache reports unavailable storage. */ }
  return {
    review: readCache(SESSION_ID ? `logic-margin:session:${SESSION_ID}:unused` : STORAGE_PREFIX + activeId, parseReview, sampleReview),
    drafts: readCache(DRAFTS_KEY, parseDrafts, []),
    history: readCache(SESSION_ID ? `logic-margin:session:${SESSION_ID}:unused-history` : HISTORY_KEY, parseRecordHistory, []),
  }
}

export default function App() {
  const [initial] = useState(readWorkspace)
  const [review, setReview] = useState(initial.review.value)
  const latestReview = useRef(review)
  latestReview.current = review
  const [drafts, setDrafts] = useState<CommentDraft[]>(initial.drafts.value)
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const [history, setHistory] = useState<ReviewRecord[]>(initial.history.value)
  const historyRef = useRef(history)
  historyRef.current = history
  const [recovery, setRecovery] = useState({ review: initial.review.recovery, drafts: initial.drafts.recovery, history: initial.history.recovery })
  const [notice, setNotice] = useState(Object.values(initial).some(item => item.error) ? '本地记录读取失败，原始数据已保留；请先备份损坏记录。' : '')
  const [status, setStatus] = useState('')
  const [saveState, setSaveState] = useState('本地保存')
  const [draftSaveError, setDraftSaveError] = useState('')
  const [historySaveError, setHistorySaveError] = useState('')
  const [sceneId, setSceneId] = useState(review.scenes[0].id)
  const [selection, setSelection] = useState<Target[]>([])
  const [tab, setTab] = useState<'detail' | 'comments' | 'drafts' | 'changes'>('detail')
  const [viewRound, setViewRound] = useState<number | null>(null)
  const receivedRound = useRef(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(() => matchMedia('(min-width: 901px)').matches)
  const [focusMode, setFocusMode] = useState(false)
  const infoRef = useRef<HTMLDetailsElement>(null)
  const [filter, setFilter] = useState<'all' | CommentStatus>('all')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [continuous, setContinuous] = useState(false)
  const reviewQueue = useRef<string[]>([])
  const [composer, setComposer] = useState<CommentDraft | null>(null)
  const [docked, setDocked] = useState(false)
  const [point, setPoint] = useState<{ x: number; y: number } | undefined>()
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const origin = useRef<HTMLElement | null>(null)
  const [mode, setMode] = useState<'pan' | 'select'>('pan')
  const [importChanges, setChanges] = useState(EMPTY_CHANGES)
  const [submitting, setSubmitting] = useState(false)
  const [loadingSpiritSanctum, setLoadingSpiritSanctum] = useState(false)
  const [sessionAction, setSessionAction] = useState(false)
  const importSequence = useRef(0)
  const exampleController = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const graph = useRef<GraphCanvasHandle>(null)
  const unresolved = useMemo(() => review.comments.filter(comment => comment.status !== 'resolved'), [review.comments])
  const currentDrafts = drafts.filter(draft => draft.documentId === review.id && draft.revision === review.revision && draft.fingerprint === review.snapshot.fingerprint)
  const validDrafts = currentDrafts.filter(draft => draft.replyTo ? review.comments.some(comment => comment.id === draft.replyTo) : draft.targets.every(target => targetExists(review, target)))
  const visibleComments = useMemo(() => review.comments.filter(comment => filter === 'all' || comment.status === filter), [review.comments, filter])
  const commentOrder = useMemo(() => review.comments.map(comment => comment.id), [review.comments])
  const reviewIdentity = useMemo(() => SESSION_ID ? '' : JSON.stringify(parseReview(review)), [review])
  const localApproved = useMemo(() => history.some(record => record.kind === 'logic-margin-approval' && JSON.stringify(record.review) === reviewIdentity), [history, reviewIdentity])
  const graphSelection = useCallback((targets: Target[]) => setSelection(targets), [])
  const receiveSession = useCallback((next: CurrentSession) => {
    if (receivedRound.current && receivedRound.current !== next.round) {
      setViewRound(null); setSelection([]); setComposer(null); setSubmitting(false); setContinuous(false)
    }
    receivedRound.current = next.round
    latestReview.current = next.review; setReview(next.review)
  }, [])
  const session = useReviewSession(SESSION_ID, receiveSession)
  const pending = useMemo(() => session.session ? currentPendingFeedback(review, session.session) : pendingFeedback(review, history), [review, history, session.session])
  const approved = session.session ? session.session.phase === 'approved' && review === session.session.review : localApproved
  const activeRound = session.session && viewRound !== null && session.session.snapshots.some(snapshot => snapshot.round === viewRound) ? viewRound : session.session?.round ?? 1
  const historical = !!session.session && activeRound !== session.session.round
  const displayReview = useMemo(() => {
    const snapshot = historical ? session.snapshots.get(activeRound) : undefined
    if (!snapshot || !session.session) return review
    const origins = new Map(session.session.commentOrigins.map(item => [item.commentId, item.round]))
    return { ...snapshot, comments: review.comments.filter(comment => (origins.get(comment.id) ?? Infinity) <= activeRound && comment.targets.some(target => targetExists(snapshot, target))) }
  }, [historical, session.snapshots, session.session, activeRound, review])
  const baselineRound = session.session?.snapshots.at(-1)?.publication?.baseRound ?? (session.session?.round ?? 1) - 1
  const baselineReview = session.snapshots.get(baselineRound)
  const baseline = baselineReview ? { round: baselineRound, review: baselineReview } : undefined
  const sessionChanges = useMemo(() => baselineReview ? getRevisionChanges(baselineReview, review) : undefined, [baselineReview, review])
  const changes = sessionChanges ?? importChanges
  const graphChanges = historical && activeRound !== baseline?.round ? EMPTY_CHANGES : changes
  const publication = session.session?.snapshots.find(snapshot => snapshot.round === session.session!.round)?.publication
  const publicationPending = session.session?.phase === 'agent-working' || session.session?.phase === 'feedback-ready'
  const scene = displayReview.scenes.find(item => item.id === sceneId) ?? displayReview.scenes[0]
  const selectedNode = selection.length === 1 && selection[0].kind === 'node' ? displayReview.nodes.find(node => node.id === selection[0].id) : undefined
  const selectedEdge = selection.length === 1 && selection[0].kind === 'edge' ? displayReview.edges.find(edge => edge.id === selection[0].id) : undefined
  const displaySaveState = SESSION_ID ? session.saveState : saveState
  const sessionBlocked = !!SESSION_ID && (!session.ready || !!session.error || session.busy || sessionAction)
  const reviewBlocked = sessionBlocked || historical || publicationPending
  const sceneDraftKey = historical ? '' : validDrafts.find(draft => !draft.replyTo && draft.targets.some(target => target.kind === 'review' || targetSceneId(review, target) === scene.id))?.key ?? ''
  // A draft key freezes its anchors, so body edits keep the canvas props stable.
  const canvasDraftTargets = useMemo(() => validDrafts.find(draft => draft.key === sceneDraftKey)?.targets ?? EMPTY_TARGETS, [sceneDraftKey])

  useEffect(() => {
    if (baselineRound >= 1 && session.session) void session.loadSnapshot(baselineRound).catch(error => setNotice(`读取修改前流程失败：${error instanceof Error ? error.message : '请重试'}`))
  }, [baselineRound, session.session?.id, session.loadSnapshot])

  useEffect(() => {
    if (SESSION_ID) return
    if (recovery.review !== null) { setSaveState('保存已暂停'); return }
    try {
      localStorage.setItem(STORAGE_PREFIX + review.id, JSON.stringify(review))
      localStorage.setItem(ACTIVE_KEY, review.id)
      setSaveState('已保存到本机')
    } catch { setSaveState('本地保存失败，请导出') }
  }, [review, recovery.review])
  useEffect(() => {
    if (recovery.drafts !== null) return
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); setDraftSaveError('') }
    catch { setDraftSaveError('草稿保存失败，请导出草稿后再离开。') }
  }, [drafts, recovery.drafts])
  useEffect(() => {
    if (SESSION_ID) return
    if (recovery.history !== null) return
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); setHistorySaveError('') }
    catch { setHistorySaveError('评审记录保存失败，请保留已下载的意见包或通过记录。') }
  }, [history, recovery.history])
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(''), 6000)
    return () => clearTimeout(timer)
  }, [status])

  const reposition = useCallback(() => {
    if (!composer || docked) return
    const rect = graph.current?.getTargetRect(composer.targets)
    const bounds = graph.current?.getCanvasRect()
    const x = rect?.right ?? point?.x ?? bounds?.left ?? 12
    const y = rect?.top ?? point?.y ?? bounds?.top ?? 12
    const surface = document.querySelector<HTMLElement>('[data-composer]')
    const height = Math.min(surface?.offsetHeight ?? 380, innerHeight - 24)
    let left = Math.max(12, Math.min(x + 12, innerWidth - 372))
    let top = Math.max(12, Math.min(y, innerHeight - height - 12))
    const warnings = document.querySelector('.workspace-notifications')?.getBoundingClientRect()
    const width = surface?.offsetWidth ?? 360
    if (warnings && warnings.height > 0 && left < warnings.right && left + width > warnings.left && top < warnings.bottom && top + height > warnings.top) {
      if (warnings.bottom + height + 24 <= innerHeight) top = warnings.bottom + 12
      else if (warnings.left >= width + 24) left = warnings.left - width - 12
    }
    setPosition(current => current.left === left && current.top === top ? current : { left, top })
  }, [composer?.key, docked, point])
  useEffect(() => {
    reposition()
    let frame = 0
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reposition) })
    const surface = document.querySelector('[data-composer]')
    if (surface) observer.observe(surface)
    const notifications = document.querySelector('.workspace-notifications')
    if (notifications) observer.observe(notifications)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [reposition, panelOpen])
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return
      const menu = document.querySelector<HTMLDetailsElement>('details.workspace-menu[open]')
      if (menu) { closeMenus(); menu.querySelector('summary')?.focus(); return }
      if (composer) { closeComposer(); return }
      if (submitting) { setSubmitting(false); return }
      if (focusMode) { setFocusMode(false); return }
      if (navOpen && matchMedia('(max-width: 900px)').matches) setNavOpen(false)
    }
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return
      document.querySelectorAll<HTMLDetailsElement>('details.workspace-menu[open]').forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false })
      if (composer && !docked && !event.target.closest('[data-composer], [data-keep-composer]')) setComposer(null)
    }
    window.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', outside) }
  }, [!!composer, docked, focusMode, submitting, navOpen])
  useEffect(() => {
    if (panelOpen && threadId) document.getElementById(`thread-${threadId}`)?.scrollIntoView({ block: 'nearest' })
  }, [threadId, panelOpen])
  useEffect(() => {
    if (!SESSION_ID && new URLSearchParams(window.location.search).get('review') === 'spirit-sanctum') void openSpiritSanctum(true)
    return () => { importSequence.current++; exampleController.current?.abort() }
  }, [])

  const replaceReview = useCallback((next: ReviewDocument) => {
    if (SESSION_ID) session.enqueue(latestReview.current, next)
    latestReview.current = next; setReview(next)
  }, [session.enqueue])
  async function startSession() {
    setSessionAction(true)
    try {
      const next = await session.create(latestReview.current)
      const url = new URL(window.location.href)
      url.search = ''; url.searchParams.set('session', next.id)
      window.location.assign(url)
    } catch (error) { setNotice(error instanceof Error ? error.message : '会话创建失败') }
    finally { setSessionAction(false) }
  }
  async function backupAndRecoverSession() {
    if (!session.pendingRecovery) return
    download(session.pendingRecovery, 'logic-margin-unsent.json')
    try { await session.recoverRemote(); setNotice(''); closeComposer(false) }
    catch (error) { setNotice(error instanceof Error ? error.message : '恢复会话失败，未同步意见仍保留。') }
  }
  async function backupFullSession() {
    try {
      const full = await sessionRequest(`/${encodeURIComponent(SESSION_ID!)}`)
      if (!full) throw new Error('服务未返回完整会话')
      download(JSON.stringify(full, null, 2), `logic-margin-session-${full.id}.json`)
    } catch (error) { setNotice(error instanceof Error ? error.message : '完整会话备份失败') }
  }
  async function downloadRecord(id: string) {
    try {
      const record = await recordRequest(SESSION_ID!, id)
      download(JSON.stringify(record, null, 2), `${filename(record.review.id)}-${record.id}.json`)
    } catch (error) { setNotice(error instanceof Error ? error.message : '评审记录读取失败') }
  }
  function remember(draft: CommentDraft) {
    try { const next = withDraft(draftsRef.current, draft); draftsRef.current = next; setDrafts(next) }
    catch (error) { setNotice(error instanceof Error ? error.message : '草稿无法保存，请导出后再离开。') }
  }
  const closeComposer = useCallback((restore = true) => {
    setComposer(null)
    if (restore && matchMedia('(min-width: 901px) and (pointer: fine)').matches) setTimeout(() => origin.current?.focus({ preventScroll: true }), 0)
  }, [])
  function switchScene(id: string) {
    setSceneId(id); setSelection([]); closeComposer(false)
    if (matchMedia('(max-width: 900px)').matches) setNavOpen(false)
  }
  function openPanel(nextTab: typeof tab) { setFocusMode(false); setPanelOpen(true); setTab(nextTab) }
  function toggleFocus() {
    closeMenus()
    if (!focusMode && docked) setDocked(false)
    setFocusMode(current => !current)
  }
  async function switchRound(round: number) {
    try {
      if (round !== session.session?.round) await session.loadSnapshot(round)
      setViewRound(round); setSelection([]); closeComposer(false); setContinuous(false); setSubmitting(false)
    } catch (error) { setNotice(`读取历史流程失败：${error instanceof Error ? error.message : '请重试'}`) }
  }
  const showTargets = useCallback(async (targets: Target[], round = activeRound) => {
    try {
      const document = session.session && round !== session.session.round ? await session.loadSnapshot(round) : review
      if (session.session) setViewRound(round)
      const id = targets.map(target => targetSceneId(document, target)).find(Boolean) ?? document.scenes[0].id
      setSceneId(id)
      setSelection(targets.filter(target => (target.kind === 'node' || target.kind === 'edge') && targetExists(document, target) && targetSceneId(document, target) === id))
      requestAnimationFrame(() => graph.current?.focusTargets(targets))
    } catch (error) { setNotice(`定位历史流程失败：${error instanceof Error ? error.message : '请重试'}`) }
  }, [review, session.session, session.loadSnapshot, activeRound])
  const openComposer = useCallback((targets: Target[], at?: { x: number; y: number }, replyTo?: string) => {
    if (historical) { setStatus('历史流程只读，请回到当前版本继续讨论。'); return }
    try {
      const key = draftKey(review, targets, replyTo)
      const existing = draftsRef.current.find(item => item.key === key)
      if (!existing && draftsRef.current.length >= 200) throw new Error('草稿已达 200 份上限，请先到草稿列表导出并移除已有草稿。')
      const draft = existing ?? makeDraft(review, targets, '', replyTo)
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPoint(at); setComposer(draft); setDocked(!!replyTo)
      if (replyTo) { setFocusMode(false); setPanelOpen(true); setTab('comments') }
      setStatus('')
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法打开编辑器') }
  }, [review, historical])
  const openThread = useCallback((id: string) => {
    const comment = review.comments.find(item => item.id === id)
    if (!comment) return
    closeComposer(false); setThreadId(id); setFilter('all'); setTab('comments'); setFocusMode(false); setPanelOpen(true); showTargets(comment.targets)
  }, [review, closeComposer, showTargets])
  function saveComposer(): string | null {
    if (historical || sessionBlocked) return '请回到当前版本并等待同步完成后保存'
    if (!composer) return '请先选择批注位置'
    try {
      if (composer.key !== draftKey(latestReview.current, composer.targets, composer.replyTo)) throw new Error('这是旧版本草稿，请回到草稿列表导出后核对新版。')
      const next = composer.replyTo ? addReply(latestReview.current, composer.replyTo, composer.body) : addComment(latestReview.current, composer.targets, composer.body)
      replaceReview(next); remember({ ...composer, body: '' }); setThreadId(composer.replyTo ?? next.comments.at(-1)!.id)
      if (docked) { setTab('comments'); setFilter('all') }
      closeComposer(); setStatus(composer.replyTo ? '回复已保存。' : '批注已保存。')
      return null
    } catch (error) { return error instanceof Error ? error.message : '批注保存失败' }
  }
  function applyImport(payload: unknown) {
    if (Array.isArray(payload)) {
      setHistory(parseRecordHistory([...historyRef.current, ...parseRecordHistory(payload)]))
      setStatus('固定版本记录已恢复到本地历史。'); return false
    }
    if (payload && typeof payload === 'object' && 'kind' in payload) {
      const record = parseReviewRecord(payload)
      setHistory(parseRecordHistory([...historyRef.current, record]))
      setStatus('固定版本记录已导入历史，当前流程保持原版本。'); return false
    }
    const incoming = parseReview(payload)
    let previous: ReviewDocument | undefined = latestReview.current.id === incoming.id ? latestReview.current : undefined
    if (!previous) {
      const saved = localStorage.getItem(STORAGE_PREFIX + incoming.id)
      if (saved) previous = parseReview(JSON.parse(saved))
    }
    const next = previous ? rebaseReview(previous, incoming) : incoming
    setChanges(previous ? getChanges(previous, incoming) : EMPTY_CHANGES)
    replaceReview(next); switchScene(next.scenes[0].id); setThreadId(null); setSubmitting(false); setContinuous(false); setNotice('')
    setStatus('评审已导入，原批注与各版本草稿均保留。')
    return true
  }
  function updateExampleLink(enabled: boolean) {
    const url = new URL(window.location.href)
    if (enabled) url.searchParams.set('review', 'spirit-sanctum')
    else if (url.searchParams.get('review') === 'spirit-sanctum') url.searchParams.delete('review')
    window.history.replaceState(null, '', url)
  }
  async function importFile(file: File) {
    const sequence = ++importSequence.current
    exampleController.current?.abort()
    setLoadingSpiritSanctum(false)
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('评审文件不能超过 10 MB')
      const text = await file.text()
      if (sequence === importSequence.current && applyImport(JSON.parse(text))) updateExampleLink(false)
    } catch (error) {
      if (sequence === importSequence.current) setNotice(`导入失败：${error instanceof Error ? error.message : '文件无法读取'}。当前评审已保留。`)
    }
  }
  async function openSpiritSanctum(restoreSaved = false) {
    const sequence = ++importSequence.current
    exampleController.current?.abort()
    const controller = new AbortController()
    exampleController.current = controller
    setLoadingSpiritSanctum(true)
    try {
      if (restoreSaved) {
        const saved = localStorage.getItem(STORAGE_PREFIX + 'vast-spirit-sanctum')
        if (saved) {
          const incoming = parseReview(JSON.parse(saved))
          if (incoming.id !== 'vast-spirit-sanctum') throw new Error('本机魔灵秘境记录的评审 ID 不匹配，原记录未覆盖')
          applyImport(incoming); updateExampleLink(true); setStatus(''); return
        }
      }
      const response = await fetch(SPIRIT_SANCTUM_PATH, { signal: controller.signal })
      if (!response.ok) throw new Error(`评审包读取失败（HTTP ${response.status}）`)
      const file = await response.blob()
      if (file.size > 10 * 1024 * 1024) throw new Error('评审文件不能超过 10 MB')
      const text = await file.text()
      if (sequence === importSequence.current) {
        const incoming = parseReview(JSON.parse(text))
        if (incoming.id !== 'vast-spirit-sanctum') throw new Error('此文件不是魔灵秘境评审包')
        applyImport(incoming); updateExampleLink(true)
        if (restoreSaved) setStatus('')
      }
    } catch (error) {
      if (sequence === importSequence.current && !controller.signal.aborted) setNotice(`打开魔灵秘境失败：${error instanceof Error ? error.message : '评审包无法读取'}。当前评审已保留。`)
    } finally {
      if (sequence === importSequence.current) setLoadingSpiritSanctum(false)
    }
  }
  function selectTarget(target: Target, additive = false) {
    const id = targetSceneId(displayReview, target)
    if (!targetExists(displayReview, target)) { setNotice('此目标已移除；原意见仍保留供复核。'); return }
    if (id && id !== sceneId) setSceneId(id)
    setSelection(current => additive && id === sceneId ? current.some(item => keyOf(item) === keyOf(target)) ? current.filter(item => keyOf(item) !== keyOf(target)) : [...current, target] : [target])
  }
  const reviewNext = useCallback((id: string, resolved: boolean) => {
    try {
      if (reviewBlocked) throw new Error(historical ? '历史流程只读，请回到当前版本复核。' : publicationPending ? '新版尚未发布，请等待代理发布后复核。' : '请等待会话同步完成后复核，避免确认尚未看到的回复。')
      const next = setCommentStatus(latestReview.current, id, resolved ? 'resolved' : 'open')
      replaceReview(next)
      if (!continuous) return
      reviewQueue.current = reviewQueue.current.filter(item => item !== id)
      const following = reviewQueue.current.find(item => next.comments.some(comment => comment.id === item && comment.status !== 'resolved'))
      if (following) openThread(following)
      else { setContinuous(false); setStatus(next.comments.some(comment => comment.status !== 'resolved') ? '本轮意见已逐条复核，仍需处理的意见已保留。' : '本轮意见已逐条复核，可单独确认整轮通过。') }
    } catch (error) { setNotice(error instanceof Error ? error.message : '复核状态保存失败') }
  }, [reviewBlocked, historical, publicationPending, replaceReview, continuous, openThread])
  function archiveHistory() {
    const payload = JSON.stringify(history, null, 2)
    if (new TextEncoder().encode(payload).byteLength > 10 * 1024 * 1024) {
      setNotice('归档超过 10 MB，请逐份下载固定记录；本机历史已保留。'); return
    }
    download(payload, 'logic-margin-record-history.json'); setHistory([])
  }
  async function generateFeedback(saveDrafts: boolean) {
    if (historical) return
    setSessionAction(true)
    try {
      let next = latestReview.current
      if (saveDrafts) for (const draft of currentDrafts) {
        if (draft.key !== draftKey(next, draft.targets, draft.replyTo)) throw new Error('流程已更新，旧版本草稿已保留，请先核对新版。')
        if (!validDrafts.some(item => item.key === draft.key)) throw new Error('有草稿的目标已移除，请先到草稿列表核对或导出。')
        if (draft.replyTo && next.comments.find(comment => comment.id === draft.replyTo)?.status !== 'open') throw new Error('有回复属于待复核或已解决意见，请先保存回复并复核，再提交本轮。')
        next = draft.replyTo ? addReply(next, draft.replyTo, draft.body) : addComment(next, draft.targets, draft.body)
      }
      const comments = session.session ? currentPendingFeedback(next, session.session) : pendingFeedback(next, history)
      if (!comments.length) throw new Error('没有新的待处理意见；待复核意见请先确认处理结果。')
      const clearSubmittedDrafts = () => {
        if (!saveDrafts) return
        let remaining = draftsRef.current
        for (const draft of currentDrafts) {
          if (remaining.some(item => item.key === draft.key && item.body === draft.body && item.updatedAt === draft.updatedAt)) remaining = withDraft(remaining, { ...draft, body: '' })
        }
        draftsRef.current = remaining; setDrafts(remaining); closeComposer(false)
      }
      if (SESSION_ID) {
        if (next !== latestReview.current) replaceReview(next)
        clearSubmittedDrafts()
        await session.finish('feedback')
      } else {
        const record = createFeedbackPackage({ ...next, comments })
        const records = parseRecordHistory([...history, record])
        replaceReview(next); setHistory(records)
        clearSubmittedDrafts()
        download(JSON.stringify(record, null, 2), `${filename(review.id)}-${record.id}.feedback.json`)
      }
      setSubmitting(false); setStatus(SESSION_ID ? '本轮已提交，等待代理接收。可在评审信息中查看会话状态。' : '意见包已生成，待交给代理。文件包含本轮意见与固定流程快照。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '意见包生成失败') }
    finally { setSessionAction(false) }
  }
  async function approve() {
    if (reviewBlocked) return
    setSessionAction(true)
    try {
      if (currentDrafts.length) throw new Error('还有本版本草稿，请先保存并处理后再确认整轮通过。')
      if (SESSION_ID) await session.finish('approval')
      else {
        const record = createApprovalRecord(review)
        setHistory(parseRecordHistory([...history, record]))
        download(JSON.stringify(record, null, 2), `${filename(review.id)}-${record.id}.approval.json`)
      }
      setStatus('已记录整轮通过。此记录仅对应当前流程快照。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '通过记录生成失败') }
    finally { setSessionAction(false) }
  }

  if (SESSION_ID && !session.ready) return <main className="session-loading"><h1>LogicMargin</h1><p role={session.error ? 'alert' : 'status'}>{session.error || '正在恢复评审会话…'}</p><button className="button" onClick={session.retry}>重新连接</button>{session.pendingRecovery && <><button className="button" onClick={() => download(session.pendingRecovery!, 'logic-margin-unsent.json')}>导出未同步意见</button><button className="button" disabled={session.busy} onClick={() => void backupAndRecoverSession()}>备份未同步意见并恢复服务端版本</button></>}<a href="/">打开本机评审</a></main>

  return <div className={`app-shell ${focusMode ? 'is-focused' : ''}`}>
    <header className="topbar">
      <button className="button icon-button nav-toggle" data-keep-composer aria-label={navOpen ? '收起场景导航' : '展开场景导航'} aria-expanded={navOpen} aria-controls="scene-navigation" onClick={() => setNavOpen(current => !current)}>{navOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
      <span className="brand-mark" title="LogicMargin · 逻辑旁批"><GitBranch size={20} /></span>
      <h1 className="review-title" title={review.title}>{review.title}</h1>
      <details ref={infoRef} className="workspace-menu review-tools"><summary className="button" aria-label="评审信息"><Info size={15} /><span className="button-text">评审信息</span></summary>
        <div className="review-info-card"><h2>评审说明</h2><p><strong>{review.title}</strong></p><p className="document-description">{review.description}</p>
          {session.session && <section className="detail-section" aria-label="代理评审会话"><h3>第 {session.session.round} 轮 · {phaseLabels[session.session.phase]}</h3><p>会话 ID <code>{session.session.id}</code></p><p>批注保存到本机服务端；提交本轮后代理才能继续。代理发布新版时，原意见与回复会自动恢复。</p><button className="button" onClick={() => void backupFullSession()}>备份完整会话</button></section>}
          <div className="document-meta"><span className="badge">{review.revision}</span>{review.snapshot.dirty && <span className="badge warning">包含未提交改动</span>}{approved && <span className="badge">本轮已通过</span>}</div>
          <p className="muted">{review.snapshot.repository}<br />代码 {review.snapshot.commit}<br />采集于 {new Date(review.snapshot.capturedAt).toLocaleString('zh-CN')}</p>
          <section className="detail-section"><h3>当前场景</h3><p>{scene.title} · {scene.description}</p></section>
          {!!(changes.added.length + changes.changed.length + changes.removed.length) && <div className="revision-banner"><strong>已载入新版流程</strong><p>新增 {changes.added.length} 项 · 变化 {changes.changed.length} 项 · 移除 {changes.removed.length} 项。原批注已保留，请复核受影响意见。</p></div>}
          <h3>已展示</h3><ul className="coverage-list">{review.coverage.included.map(item => <li key={item}>{item}</li>)}</ul><h3>尚未覆盖</h3><ul className="coverage-list">{review.coverage.excluded.map(item => <li key={item}>{item}</li>)}</ul><p>{review.coverage.note}</p><p>快照指纹 <code>{review.snapshot.fingerprint}</code></p>
        </div>
      </details>
      <div className="topbar-actions"><span className={`save-state ${displaySaveState.includes('失败') ? 'save-error' : ''}`} role="status"><Circle size={7} fill="currentColor" />{displaySaveState}</span>
        <input className="screen-reader-only" ref={inputRef} type="file" accept=".json,application/json" aria-label="导入评审文件" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} />
        <details className="workspace-menu file-menu"><summary className="button">文件</summary><div className="menu-content">
          <button className="button" disabled={!!SESSION_ID} onClick={() => { closeMenus(); inputRef.current?.click() }}><Upload size={15} />导入评审</button>
          <button className="button mobile-file-action" onClick={() => { closeMenus(); download(serializeReview(review), `${filename(`${review.id}-${review.revision}`)}.logic-margin.json`) }}><ArrowDownToLine size={15} />导出评审</button>
          {HAS_BUNDLED_SPIRIT_REVIEW && <button className="button" disabled={!!SESSION_ID || loadingSpiritSanctum} aria-busy={loadingSpiritSanctum} onClick={() => { closeMenus(); void openSpiritSanctum() }}>{loadingSpiritSanctum ? '正在打开魔灵秘境…' : '打开魔灵秘境评审'}</button>}
          {!SESSION_ID && review.id !== sampleReview.id && <button className="button" onClick={() => { closeMenus(); void importFile(new File([JSON.stringify(sampleReview)], 'sample.json')) }}>打开 Vast 样例</button>}
          {SESSION_ID ? <a className="button" href="/">返回本机评审</a> : <button className="button" disabled={sessionAction} onClick={() => { closeMenus(); void startSession() }}>建立代理评审会话</button>}
        </div></details>
        <button className="button desktop-file-action" onClick={() => download(serializeReview(review), `${filename(`${review.id}-${review.revision}`)}.logic-margin.json`)}><ArrowDownToLine size={15} />导出评审</button>
        <button className="button primary" disabled={sessionBlocked || historical || (!pending.length && !currentDrafts.length)} onClick={() => { closeComposer(false); setSubmitting(true) }}>提交本轮{pending.length ? `（${pending.length}）` : ''}</button>
      </div>
    </header>
    <div className="workspace-notifications">
      {session.error && <div className="notice error" role="alert"><p>{session.error}</p><button className="button" onClick={session.retry}>重新连接</button>{session.pendingRecovery && <><button className="button" onClick={() => download(session.pendingRecovery!, 'logic-margin-unsent.json')}>导出未同步意见</button><button className="button" disabled={session.busy} onClick={() => void backupAndRecoverSession()}>备份未同步意见并恢复服务端版本</button></>}</div>}
      {focusMode && displaySaveState.includes('失败') && <div className="notice error" role="alert"><p>{displaySaveState}</p><button className="button" onClick={() => download(serializeReview(review), `${filename(`${review.id}-${review.revision}`)}.logic-margin.json`)}>导出评审</button></div>}
      {notice && <div className="notice error" role="alert"><p>{notice}</p><button className="icon-button button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {status && <div className="notice status-notice" role="status"><p>{status}</p><button className="icon-button button" aria-label="关闭状态提示" onClick={() => setStatus('')}><X size={16} /></button></div>}
      {Object.entries(recovery).map(([key, raw]) => raw !== null && <div className="notice error" key={key}><p>{key === 'review' ? '自动保存已暂停，避免覆盖损坏的记录。' : `${key === 'drafts' ? '草稿' : '评审历史'}原始数据已保留，自动保存暂停。`}</p><button className="button" onClick={() => { download(raw, `logic-margin-${key}-recovery.txt`, 'text/plain'); setRecovery(current => ({ ...current, [key]: null })); setNotice('') }}>{key === 'review' ? '备份原记录并启用保存' : `备份${key === 'drafts' ? '草稿' : '历史'}原记录并启用保存`}</button></div>)}
      {(draftSaveError || historySaveError) && <div className="notice error" role="alert"><p>{draftSaveError || historySaveError}</p><button className="button" onClick={() => download(JSON.stringify(drafts, null, 2), 'logic-margin-drafts.json')}>导出草稿</button></div>}
    </div>
    <div className={`workspace ${panelOpen ? 'panel-open' : 'panel-closed'} ${navOpen ? 'nav-open' : 'nav-collapsed'}`}>
      <button className="nav-shade" aria-label="关闭场景导航" onClick={() => setNavOpen(false)} />
      <aside id="scene-navigation" className="sidebar" aria-label="评审场景"><span className="project-label">流程场景 · {displayReview.scenes.length}</span>
        <nav>{displayReview.scenes.map((item, index) => <button key={item.id} className={`scene-button ${scene.id === item.id ? 'active' : ''}`} onClick={() => switchScene(item.id)} aria-current={scene.id === item.id ? 'page' : undefined}><span className="scene-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{displayReview.nodes.filter(node => node.sceneId === item.id).length} 个步骤</small></span><ChevronRight size={14} /></button>)}</nav>
        <div className="sidebar-note"><ShieldCheck size={16} /><p>选择步骤查看规则与源码；{SESSION_ID ? '意见同步到本机服务端，草稿保存在当前浏览器。' : '意见与草稿保存在当前浏览器。'}</p></div>
      </aside>
      <main className="review-main">
        <div className="graph-toolbar">
          <div className="scene-context"><h2 className="scene-title" title={`${scene.title} · ${scene.description}`}>{scene.title}</h2><label className="mobile-scene-select"><select aria-label="场景" value={scene.id} onChange={event => switchScene(event.target.value)}>{displayReview.scenes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
          {session.session && <RevisionControls session={session.session} viewRound={activeRound} onViewRound={switchRound} onOpenChanges={() => openPanel('changes')} />}
          <div className="tool-group"><button className={`button ${mode === 'pan' ? 'active' : ''}`} aria-label="浏览" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={14} /><span className="tool-label">浏览</span></button><button className={`button ${mode === 'select' ? 'active' : ''}`} aria-label="框选" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><Scan size={14} /><span className="tool-label">框选</span></button></div>
          {!!selection.length && <button className="button subtle clear-selection" onClick={() => setSelection([])}>清除选择</button>}
          <div className="tool-group toolbar-actions"><button className="button" data-keep-composer onClick={() => openPanel('detail')}>步骤详情</button><button className="button" data-keep-composer onClick={() => openPanel('comments')}><MessageSquare size={14} />批注 {review.comments.length}</button><button className="button" data-keep-composer onClick={() => openPanel('drafts')}>草稿 {drafts.length}</button>
            <details className="workspace-menu scope-actions"><summary className="button">批注</summary><div className="menu-content"><button className="button" disabled={historical} onClick={() => { closeMenus(); openComposer([{ kind: 'scene', id: scene.id }]) }}>批注此场景</button><button className="button" disabled={historical} onClick={() => { closeMenus(); openComposer([{ kind: 'review', id: review.id }]) }}>批注整个评审</button></div></details>
            <button className="button icon-button locate-selection" data-keep-composer aria-label="定位当前选择" disabled={!selection.length} onClick={() => graph.current?.focusTargets(selection)}><Focus size={16} /></button>
            <button className="button focus-toggle" data-keep-composer aria-label={focusMode ? '退出专注' : '专注画布'} aria-pressed={focusMode} onClick={toggleFocus}><Maximize2 size={15} /><span className="focus-label">{focusMode ? '退出专注' : '专注画布'}</span></button>
          </div>
        </div>
        {submitting && <section className="feedback-summary" aria-label="提交本轮意见"><h3>{SESSION_ID ? '提交本轮意见' : '生成本轮意见包'}</h3><p>{pending.length} 条新意见 · {currentDrafts.length} 份本版本草稿。{SESSION_ID ? '提交会固定当前流程与源码版本，并通知等待中的代理。' : '意见包固定当前流程与源码版本，生成后需要交给代理。'}</p>{currentDrafts.length > 0 && <p>草稿可以先保存后提交，也可以留到下一轮；旧版本草稿始终保留。</p>}<div className="tool-group">{currentDrafts.length > 0 && <button className="button primary" disabled={sessionAction} onClick={() => void generateFeedback(true)}>保存草稿并提交</button>}<button className={`button ${currentDrafts.length ? '' : 'primary'}`} disabled={sessionAction || !pending.length} onClick={() => void generateFeedback(false)}>{sessionAction ? '正在提交…' : currentDrafts.length ? '仅提交已保存意见' : SESSION_ID ? '提交给代理' : '生成意见包'}</button><button className="button" onClick={() => setSubmitting(false)}>取消</button></div></section>}
        {publicationPending && <div className="revision-banner publication-pending" role="status"><strong>修改中，新版尚未发布</strong><p>当前仍是 R{session.session?.round} 的流程图。代理交流回复不代表修改已完成；新版发布后才能确认处理结果。</p></div>}
        {historical && <div className="revision-banner historical-banner"><span>正在查看 R{activeRound} 的历史流程 · 只读；讨论栏显示当前处理状态。</span><button className="button" onClick={() => switchRound(session.session!.round)}>返回当前流程</button></div>}
        <GraphCanvas ref={graph} key={`${review.id}:${scene.id}:${session.session ? activeRound : review.revision}`} review={displayReview} sceneId={scene.id} selection={selection} setSelection={graphSelection} changes={graphChanges} mode={mode}
          readOnly={historical} viewportKey={`${SESSION_ID ?? review.id}:${activeRound}:${scene.id}`} changeSide={historical ? 'before' : 'after'} commentOrder={commentOrder}
          onOpenComposer={openComposer} onOpenThread={openThread} onViewportChange={reposition} draftTargets={canvasDraftTargets} />
        <div className="canvas-caption"><span className="selection-count">{selection.length ? `已选 ${selection.length} 项` : '选择步骤或连线'}</span><span className="canvas-help" title="右键批注 · Shift / ⌘ 多选 · 框选只选节点 · 连线可单独加入">纵向阅读 · 右键批注 · 滚轮缩放</span><span>{session.session && `第 ${session.session.round} 轮 · ${phaseLabels[session.session.phase]} · `}{unresolved.length} 条待处理意见{approved ? ' · 本轮已通过' : ''}</span></div>
      </main>
      <aside className={`inspector ${panelOpen ? 'is-open' : ''}`} aria-label="步骤详情与批注">
        <div className="inspector-tabs"><button className={tab === 'detail' ? 'active' : ''} aria-pressed={tab === 'detail'} onClick={() => setTab('detail')}>详情</button><button className={tab === 'comments' ? 'active' : ''} aria-pressed={tab === 'comments'} onClick={() => setTab('comments')}>讨论 {review.comments.length}</button><button className={tab === 'drafts' ? 'active' : ''} aria-pressed={tab === 'drafts'} onClick={() => setTab('drafts')}>草稿 {drafts.length}</button>{baseline && <button className={tab === 'changes' ? 'active' : ''} aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>变化</button>}<button className="button icon-button" aria-label="收起侧栏" onClick={() => { setPanelOpen(false); if (docked) closeComposer() }}><X size={16} /></button></div>
        <div className="inspector-body" hidden={!!composer && docked}>
          {tab === 'changes' && !baseline && <div className="empty-state"><p>正在读取修改前流程…</p><button className="button" onClick={() => void session.loadSnapshot(baselineRound).catch(error => setNotice(error instanceof Error ? error.message : '历史读取失败'))}>重新读取</button></div>}
          {tab === 'changes' && baseline && sessionChanges && <>
            <section className="detail-section publication-summary"><h3>R{baseline.round} → R{session.session?.round}</h3><p>{publication?.summary ?? '此轮由旧版客户端发布，未记录发布说明。'}</p>{publication?.unchangedReason && <p>流程未变原因：{publication.unchangedReason}</p>}{publication && <p className="muted">已核验 {publication.source.files.length} 个源文件 · {new Date(publication.source.checkedAt).toLocaleString('zh-CN')}</p>}</section>
            <RevisionChangesPanel before={baseline.review} after={review} changes={sessionChanges} onLocate={(target, side) => showTargets([target], side === 'before' ? baseline.round : session.session!.round)} />
          </>}
          {tab === 'detail' && <>
            {!selection.length ? <div className="empty-state"><MousePointer2 size={24} /><h3>从一个步骤开始</h3><p>点击图中步骤或从下面列表选择，查看业务规则与源码依据。</p></div> : <div className="inspector-heading"><span className="project-label">{selectedNode ? kindLabels[selectedNode.kind] : selectedEdge ? '连线与条件' : `已选 ${selection.length} 项`}</span><h3 className="panel-title">{selectedNode?.title ?? selectedEdge?.label ?? '这一段流程'}</h3><button className="button primary" disabled={historical} onClick={() => { openComposer(selection); setDocked(true) }}>批注所选</button></div>}
            {selectedNode && <><section className="detail-section"><h3>这里发生什么</h3><p>{selectedNode.detail}</p></section><section className="detail-section"><h3>数据变化</h3><div className="state-change"><div><span>执行前</span><strong>{selectedNode.input}</strong></div><ArrowRight size={16} /><div><span>执行后</span><strong>{selectedNode.output}</strong></div></div></section><details className="evidence"><summary>源码依据 · {selectedNode.evidence.length} 处</summary>{selectedNode.evidence.map(item => <div key={`${item.path}:${item.startLine}`} className="source-item"><code>{item.symbol}</code><small>{item.path}:{item.startLine}–{item.endLine}</small><small title={item.digest}>SHA-256 {item.digest.slice(0, 12)}</small></div>)}{!selectedNode.evidence.length && <p>此步骤尚未提供源码依据。</p>}</details></>}
            {selectedEdge && <section className="detail-section"><h3>流转条件</h3><p>{selectedEdge.detail}</p><p>{targetLabel(displayReview, { kind: 'node', id: selectedEdge.source })} → {targetLabel(displayReview, { kind: 'node', id: selectedEdge.target })}</p></section>}
            {selection.length > 1 && <div className="selection-list">{selection.map(target => <div className="selection-item" key={keyOf(target)}><span>{targetLabel(displayReview, target)}</span><button className="button icon-button" aria-label={`移除选择：${targetLabel(displayReview, target)}`} onClick={() => setSelection(current => current.filter(item => keyOf(item) !== keyOf(target)))}><X size={13} /></button></div>)}</div>}
            <details className="detail-section" open><summary>本场景的步骤与连线</summary><div className="selection-list">{displayReview.nodes.filter(node => node.sceneId === scene.id).map(node => <button key={node.id} className={`selection-item ${selection.some(target => target.kind === 'node' && target.id === node.id) ? 'active' : ''}`} onClick={event => selectTarget({ kind: 'node', id: node.id }, event.shiftKey || event.metaKey || event.ctrlKey)}><span>{node.title}</span><small>{kindLabels[node.kind]}</small></button>)}{displayReview.edges.filter(edge => edge.sceneId === scene.id).map(edge => <button key={edge.id} className={`selection-item ${selection.some(target => target.kind === 'edge' && target.id === edge.id) ? 'active' : ''}`} onClick={event => selectTarget({ kind: 'edge', id: edge.id }, event.shiftKey || event.metaKey || event.ctrlKey)}><span>{edge.label || '继续'}</span><small>连线</small></button>)}</div></details>
            <details className="detail-section coverage-note"><summary>本次展示的范围</summary><h3>已展示</h3><ul className="coverage-list">{displayReview.coverage.included.map(item => <li key={item}>{item}</li>)}</ul><h3>尚未覆盖</h3><ul className="coverage-list">{displayReview.coverage.excluded.map(item => <li key={item}>{item}</li>)}</ul><p>{displayReview.coverage.note}</p><p>采集于 {new Date(displayReview.snapshot.capturedAt).toLocaleString('zh-CN')}<br />快照指纹 <code title={displayReview.snapshot.fingerprint}>{displayReview.snapshot.fingerprint.slice(0, 16)}</code></p><p>当前网页不会实时读取仓库；代码变化后需生成并导入新版评审。</p></details>
          </>}
          {tab === 'comments' && <>
            <div className="review-navigation"><p>{unresolved.length} 条尚未确认 · {pending.length} 条可提交</p><button className="button" disabled={reviewBlocked || !unresolved.length} onClick={() => { const ordered = [...unresolved.filter(item => item.status === 'needs-review'), ...unresolved.filter(item => item.status === 'open')]; reviewQueue.current = ordered.map(item => item.id); setContinuous(true); openThread(ordered[0].id) }}>开始逐条复核</button><button className="button" disabled={reviewBlocked || !!unresolved.length || !!currentDrafts.length || approved} onClick={() => void approve()}>{approved ? '本轮已通过' : '确认整轮通过'}</button>{continuous && <button className="button subtle" onClick={() => setContinuous(false)}>退出连续复核</button>}</div>
            <div className="comment-filter" aria-label="筛选批注">{(['all', 'open', 'needs-review', 'resolved'] as const).map(item => <button key={item} className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : statusLabels[item]}</button>)}</div>
            {!visibleComments.length && <div className="empty-state"><MessageSquare size={24} /><h3>{review.comments.length ? '此状态下暂无批注' : '让意见落在具体流程上'}</h3><p>在图中选择步骤、连线或一段流程，也可以批注遗漏的场景。</p></div>}
            <CommentThreads review={review} session={session.session} snapshots={session.snapshots} comments={visibleComments} changes={changes}
              threadId={threadId} continuous={continuous} historical={historical} reviewBlocked={reviewBlocked} sessionBlocked={sessionBlocked}
              setThreadId={setThreadId} showTargets={showTargets} openComposer={openComposer} closeComposer={closeComposer} reviewNext={reviewNext} />
            {SESSION_ID ? <details className="record-list"><summary>会话评审记录 · {session.session?.history.length ?? 0}</summary>{session.session?.history.slice().reverse().map(record => <div className="draft-entry" key={record.id}><strong>{record.kind === 'logic-margin-feedback' ? '已提交的意见包' : '整轮通过记录'}</strong><small>R{record.round} · {record.revision} · {new Date(record.createdAt).toLocaleString('zh-CN')}</small><button className="button" onClick={() => void downloadRecord(record.id)}>下载固定记录</button></div>)}</details> : <>
            <details className="record-list"><summary>{SESSION_ID ? '会话评审记录' : '本地评审记录'} · {history.filter(record => record.review.id === review.id).length}</summary>{history.filter(record => record.review.id === review.id).slice().reverse().map(record => <div className="draft-entry" key={record.id}><strong>{record.kind === 'logic-margin-feedback' ? SESSION_ID ? '已提交的意见包' : '意见包 · 待交给代理' : '整轮通过记录'}</strong><small>{record.review.revision} · {new Date(record.createdAt).toLocaleString('zh-CN')}</small><button className="button" onClick={() => download(JSON.stringify(record, null, 2), `${filename(record.review.id)}-${record.id}.json`)}>下载固定记录</button></div>)}{!SESSION_ID && !!history.length && <div><p>归档会下载全部历史并从本机移除；之后旧意见可再次提交。归档文件可通过导入恢复。</p><button className="button" onClick={archiveHistory}>导出并归档全部历史</button></div>}</details>
            </>}
          </>}
          {tab === 'drafts' && <section className="draft-list"><h3>保留的草稿 · {drafts.length}</h3><p className="muted">草稿按对象与源码版本保存。旧版本或其他评审的内容可导出核对。</p>{!drafts.length && <div className="empty-state"><p>暂时没有未保存的意见。</p></div>}{drafts.map(draft => { const valid = validDrafts.some(item => item.key === draft.key); return <article className="draft-entry" key={draft.key}><strong>{draft.replyTo ? '讨论回复 · ' : ''}{draft.labels.join(' · ')}</strong><small>{draft.revision} · {draft.fingerprint.slice(0, 12)}{!valid && ' · 旧版本或原目标不可用'}</small><p>{draft.body}</p><div className="tool-group">{valid && <button className="button" disabled={historical} onClick={() => { showTargets(draft.targets); openComposer(draft.targets, undefined, draft.replyTo); setDocked(true); setPanelOpen(true) }}>继续编辑</button>}<button className="button" onClick={() => download(JSON.stringify(draft, null, 2), `logic-margin-draft-${filename(draft.revision)}.json`)}>导出这份草稿</button><button className="button subtle" onClick={() => { download(JSON.stringify(draft, null, 2), `logic-margin-draft-${filename(draft.revision)}.json`); remember({ ...draft, body: '' }) }}>导出并移除草稿</button></div></article> })}{!!drafts.length && <button className="button" onClick={() => download(JSON.stringify(drafts, null, 2), 'logic-margin-drafts.json')}>导出全部草稿</button>}</section>}
        </div>
        <CommentComposer draft={composer} docked={docked} position={position} onChange={body => { if (composer) { const next = { ...composer, body, updatedAt: new Date().toISOString() }; setComposer(next); remember(next) } }} onSave={saveComposer} onClose={() => closeComposer()} onToggle={() => { setDocked(current => !current); if (!docked) { setFocusMode(false); setPanelOpen(true); showTargets(composer?.targets ?? []) } }} />
      </aside>
    </div>
  </div>
}
