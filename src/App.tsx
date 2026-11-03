import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ChevronDown, ChevronRight, Circle, Focus, Hand, Info, Maximize2, MessageSquare, MousePointer2, PanelLeftClose, PanelLeftOpen, Scan, SlidersHorizontal, Upload, X } from 'lucide-react'
import logoUrl from './assets/logo.svg'
import type { CommentDraft, CommentStatus, ReviewChanges, ReviewDocument, ReviewRecord, Target } from './types.ts'
import { addComment, addReply, getChanges, parseReview, rebaseReview, serializeReview, setCommentStatus, targetExists, targetLabel, targetSceneId } from './model.ts'
import { createApprovalRecord, createFeedbackPackage, draftKey, makeDraft, parseDrafts, parseRecordHistory, parseReviewRecord, pendingFeedback, withDraft } from './workspace.ts'
import GraphCanvas from './GraphCanvas.tsx'
import type { GraphCanvasHandle } from './GraphCanvas.tsx'
import type { NodeAppearance } from './GraphLegend.tsx'
import CommentComposer from './CommentComposer.tsx'
import { sampleReview } from './sample.ts'
import { useReviewSession } from './useReviewSession.ts'
import type { CurrentSession, SessionSummary } from './session-types.ts'
import { getRevisionChanges } from './revisions.ts'
import { cleanupSession, currentPendingFeedback, listSessions, recordRequest, sessionRequest } from './session-client.ts'
import RevisionControls, { RevisionChangesPanel } from './RevisionControls.tsx'
import CommentThreads from './CommentThreads.tsx'

const SESSION_ID = new URLSearchParams(window.location.search).get('session')
const STORAGE_PREFIX = 'logic-margin:review:'
const ACTIVE_KEY = 'logic-margin:active'
const DRAFTS_KEY = SESSION_ID ? `logic-margin:session:${SESSION_ID}:drafts` : 'logic-margin:drafts'
const HISTORY_KEY = 'logic-margin:record-history'
const NODE_APPEARANCE_KEY = 'logic-margin:node-appearance'
const SPIRIT_SANCTUM_PATH = '/reviews/spirit-sanctum.logic-margin.json'
const HAS_BUNDLED_SPIRIT_REVIEW = import.meta.env.VITE_LOGIC_MARGIN_PACKAGED !== 'true'
const EMPTY_CHANGES: ReviewChanges = { added: [], changed: [], removed: [] }
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
  const [tab, setTab] = useState<'detail' | 'comments' | 'drafts' | 'changes'>('comments')
  const [viewRound, setViewRound] = useState<number | null>(null)
  const receivedRound = useRef(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(() => matchMedia('(min-width: 901px)').matches)
  const [compactToolbar, setCompactToolbar] = useState(() => matchMedia('(max-width: 900px)').matches)
  useEffect(() => {
    const compact = matchMedia('(max-width: 900px)')
    const update = () => setCompactToolbar(compact.matches)
    compact.addEventListener('change', update)
    return () => compact.removeEventListener('change', update)
  }, [])
  const [focusMode, setFocusMode] = useState(false)
  const infoRef = useRef<HTMLDetailsElement>(null)
  const [filter, setFilter] = useState<'all' | CommentStatus | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [continuous, setContinuous] = useState(false)
  const reviewQueue = useRef<string[]>([])
  const [composer, setComposer] = useState<CommentDraft | null>(null)
  const [discussionTargets, setDiscussionTargets] = useState<Target[] | null>(null)
  const [docked, setDocked] = useState(false)
  const [point, setPoint] = useState<{ x: number; y: number } | undefined>()
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const origin = useRef<HTMLElement | null>(null)
  const discussionOrigin = useRef<HTMLElement | null>(null)
  const [mode, setMode] = useState<'pan' | 'select'>('pan')
  const [nodeAppearance, setNodeAppearance] = useState<NodeAppearance>(() => {
    try { return localStorage.getItem(NODE_APPEARANCE_KEY) === 'distinct' ? 'distinct' : 'plain' }
    catch { return 'plain' }
  })
  const changeNodeAppearance = useCallback((appearance: NodeAppearance) => {
    setNodeAppearance(appearance)
    try { localStorage.setItem(NODE_APPEARANCE_KEY, appearance) }
    catch { /* Display preferences must not block reviewing when storage is unavailable. */ }
  }, [])
  const [importChanges, setChanges] = useState(EMPTY_CHANGES)
  const [submitting, setSubmitting] = useState(false)
  const [loadingSpiritSanctum, setLoadingSpiritSanctum] = useState(false)
  const [sessionAction, setSessionAction] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [tasks, setTasks] = useState<SessionSummary[]>([])
  const [taskPurpose, setTaskPurpose] = useState('')
  const [taskContext, setTaskContext] = useState('')
  const [taskAutoArchive, setTaskAutoArchive] = useState(false)
  const [taskError, setTaskError] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  const [deletingTask, setDeletingTask] = useState<string | null>(null)
  const tasksDialog = useRef<HTMLDialogElement>(null)
  const importSequence = useRef(0)
  const exampleController = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const graph = useRef<GraphCanvasHandle>(null)
  const unresolved = useMemo(() => review.comments.filter(comment => comment.status !== 'resolved'), [review.comments])
  const currentDrafts = drafts.filter(draft => draft.documentId === review.id && draft.revision === review.revision && draft.fingerprint === review.snapshot.fingerprint)
  const validDrafts = currentDrafts.filter(draft => draft.replyTo ? review.comments.some(comment => comment.id === draft.replyTo) : draft.targets.every(target => targetExists(review, target)))
  const selectedComments = useMemo(() => {
    const targets = new Set(selection.map(keyOf))
    return review.comments.filter(comment => comment.targets.some(target => targets.has(keyOf(target))))
  }, [review.comments, selection])
  const discussionComments = useMemo(() => {
    if (!discussionTargets) return []
    const targets = new Set(discussionTargets.map(keyOf))
    return review.comments.filter(comment => comment.targets.some(target => targets.has(keyOf(target))))
  }, [review.comments, discussionTargets])
  const commentOrder = useMemo(() => review.comments.map(comment => comment.id), [review.comments])
  const reviewIdentity = useMemo(() => SESSION_ID ? '' : JSON.stringify(parseReview(review)), [review])
  const localApproved = useMemo(() => history.some(record => record.kind === 'logic-margin-approval' && JSON.stringify(record.review) === reviewIdentity), [history, reviewIdentity])
  const graphSelection = useCallback((targets: Target[]) => setSelection(targets), [])
  const receiveSession = useCallback((next: CurrentSession) => {
    if (receivedRound.current && receivedRound.current !== next.round) {
      setViewRound(null); setSelection([]); setComposer(null); setDiscussionTargets(null); setSubmitting(false); setContinuous(false)
    }
    receivedRound.current = next.round
    latestReview.current = next.review; setReview(next.review)
  }, [])
  const session = useReviewSession(SESSION_ID, receiveSession)
  useEffect(() => {
    const dialog = tasksDialog.current
    if (tasksOpen && dialog && !dialog.open) dialog.showModal()
    else if (!tasksOpen && dialog?.open) dialog.close()
  }, [tasksOpen, session.availability])
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
  const canvasKey = JSON.stringify([SESSION_ID ?? review.id, session.session ? activeRound : [review.revision, review.snapshot.fingerprint], scene.id])
  const selectedNode = selection.length === 1 && selection[0].kind === 'node' ? displayReview.nodes.find(node => node.id === selection[0].id) : undefined
  const selectedEdge = selection.length === 1 && selection[0].kind === 'edge' ? displayReview.edges.find(edge => edge.id === selection[0].id) : undefined
  const displaySaveState = SESSION_ID ? session.saveState : saveState
  const sessionBlocked = !!SESSION_ID && (!session.ready || !!session.error || session.busy || sessionAction || session.availability !== 'active')
  const reviewBlocked = sessionBlocked || historical || publicationPending
  const needsReviewCount = unresolved.filter(comment => comment.status === 'needs-review').length
  const activeFilter = filter ?? (!approved && needsReviewCount ? 'needs-review' : 'all')
  const commentCounts = { all: review.comments.length, open: unresolved.length - needsReviewCount, 'needs-review': needsReviewCount, resolved: review.comments.length - unresolved.length }
  const visibleComments = useMemo(() => review.comments.filter(comment => activeFilter === 'all' || comment.status === activeFilter), [review.comments, activeFilter])
  useEffect(() => {
    if (filter === null && panelOpen && tab === 'comments' && (!SESSION_ID || session.ready)) setFilter(activeFilter)
  }, [filter, panelOpen, tab, session.ready, activeFilter])
  const hasFeedback = pending.length > 0
  const canApprove = !reviewBlocked && !sessionAction && !unresolved.length && !approved
  const finishLabel = hasFeedback ? '提交本轮' : approved ? '本轮已通过' : needsReviewCount ? '复核本轮' : unresolved.length ? '查看待处理意见' : '完成审查'

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
    const targets = discussionTargets ?? composer?.targets
    if (!targets || (!discussionTargets && docked)) return
    const rect = graph.current?.getTargetRect(targets)
    const bounds = graph.current?.getCanvasRect()
    const x = rect?.right ?? point?.x ?? bounds?.left ?? 12
    const y = rect?.top ?? point?.y ?? bounds?.top ?? 12
    const surface = document.querySelector<HTMLElement>('[data-composer]')
    const height = Math.min(surface?.offsetHeight ?? 380, innerHeight - 24)
    const width = surface?.offsetWidth ?? 360
    let left = Math.max(12, Math.min(x + 12, innerWidth - width - 12))
    if (rect && x + width + 24 > innerWidth && rect.left - width - 12 >= 12) left = rect.left - width - 12
    let top = Math.max(12, Math.min(y, innerHeight - height - 12))
    const warnings = document.querySelector('.workspace-notifications')?.getBoundingClientRect()
    if (warnings && warnings.height > 0 && left < warnings.right && left + width > warnings.left && top < warnings.bottom && top + height > warnings.top) {
      if (warnings.bottom + height + 24 <= innerHeight) top = warnings.bottom + 12
      else if (warnings.left >= width + 24) left = warnings.left - width - 12
    }
    setPosition(current => current.left === left && current.top === top ? current : { left, top })
  }, [composer?.key, discussionTargets, docked, point])
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
      if (discussionTargets) { closeDiscussion(); return }
      if (composer) { closeComposer(); return }
      if (submitting) { setSubmitting(false); return }
      if (focusMode) { setFocusMode(false); return }
      if (navOpen && matchMedia('(max-width: 900px)').matches) setNavOpen(false)
    }
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return
      document.querySelectorAll<HTMLDetailsElement>('details.workspace-menu[open]').forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false })
      if (!event.target.closest('[data-composer], [data-keep-composer]')) {
        if (discussionTargets) closeDiscussion(false)
        else if (composer && !docked) setComposer(null)
      }
    }
    window.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', outside) }
  }, [!!composer, discussionTargets, docked, focusMode, submitting, navOpen])
  useEffect(() => {
    if (threadId && (discussionTargets || panelOpen)) document.getElementById(`${discussionTargets ? 'discussion-thread' : 'thread'}-${threadId}`)?.scrollIntoView({ block: 'nearest' })
  }, [threadId, discussionTargets, panelOpen, tab, selection])
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
      const purpose = taskPurpose.trim()
      if (!purpose) throw new Error('请填写本次独立审查的目的。')
      const next = await session.create({ ...latestReview.current, comments: [] }, {
        scope: { purpose, ...(taskContext.trim() ? { context: taskContext.trim() } : {}) },
        cleanupPolicy: taskAutoArchive ? 'archive-on-approval' : 'manual',
      })
      const url = new URL(window.location.href)
      url.search = ''; url.searchParams.set('session', next.id)
      window.location.assign(url)
    } catch (error) { setTaskError(error instanceof Error ? error.message : '评审任务创建失败') }
    finally { setSessionAction(false) }
  }
  async function refreshTasks(context = taskContext.trim()) {
    setTaskBusy(true); setTaskError('')
    try { setTasks(await listSessions(context || undefined, setTaskError)) }
    catch (error) { setTaskError(error instanceof Error ? error.message : '评审任务读取失败') }
    finally { setTaskBusy(false) }
  }
  function openTasks() {
    closeMenus(); closeComposer(false)
    const context = session.session?.scope?.context ?? ''
    setTaskContext(context); setTaskPurpose(''); setTaskAutoArchive(false); setDeletingTask(null); setTasksOpen(true)
    void refreshTasks(context)
  }
  function taskHasLocalWork(id: string) {
    if (id === SESSION_ID && (draftsRef.current.length || session.pendingRecovery || session.busy)) return true
    const storedDrafts = localStorage.getItem(`logic-margin:session:${id}:drafts`)
    return !!localStorage.getItem(`logic-margin:session:${id}:pending`) || !!(storedDrafts && parseDrafts(JSON.parse(storedDrafts)).length)
  }
  async function downloadTask(task: SessionSummary) {
    const full = await sessionRequest(`/${encodeURIComponent(task.id)}${task.archivedAt ? '/archive' : ''}`)
    if (!full) throw new Error('服务未返回完整评审任务。')
    download(JSON.stringify(full, null, 2), `logic-margin-session-${full.id}.json`)
    return full
  }
  async function cleanTask(task: SessionSummary, mode: 'archive' | 'delete') {
    setTaskBusy(true); setTaskError('')
    try {
      if (taskHasLocalWork(task.id)) throw new Error('此任务仍有本机草稿或未同步意见。请先打开任务，保存意见或导出并移除草稿后再清理。')
      const full = await downloadTask(task)
      if (full.version !== task.version) throw new Error('评审任务已有更新，请刷新列表并核对后再清理。')
      await cleanupSession(task.id, task.version, mode)
      if (task.id === SESSION_ID) session.stop(mode === 'archive' ? 'archived' : 'deleted')
      setDeletingTask(null)
      setTasks(await listSessions(taskContext.trim() || undefined, setTaskError))
    } catch (error) { setTaskError(error instanceof Error ? error.message : '清理失败，原数据已保留。') }
    finally { setTaskBusy(false) }
  }
  async function restoreTask(task: SessionSummary) {
    setTaskBusy(true); setTaskError('')
    try {
      const restored = await sessionRequest(`/${encodeURIComponent(task.id)}/restore`, { expectedVersion: task.version })
      if (!restored) throw new Error('服务未返回恢复结果。')
      window.location.assign(`/?session=${encodeURIComponent(restored.id)}`)
    } catch (error) { setTaskError(error instanceof Error ? error.message : '恢复失败，归档仍保留。') }
    finally { setTaskBusy(false) }
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
  const closeDiscussion = useCallback((restore = true) => {
    setDiscussionTargets(null); closeComposer(false)
    if (restore) requestAnimationFrame(() => {
      const target = discussionOrigin.current?.isConnected ? discussionOrigin.current : document.querySelector<HTMLElement>('.inspector.is-open .inspector-tabs button[aria-pressed="true"]') ?? document.querySelector<HTMLElement>('.panel-toggle')
      target?.focus({ preventScroll: true })
    })
  }, [closeComposer])
  function switchScene(id: string) {
    setSceneId(id); setSelection([]); setDiscussionTargets(null); closeComposer(false)
    if (matchMedia('(max-width: 900px)').matches) setNavOpen(false)
  }
  function openPanel(nextTab: typeof tab) {
    if (discussionTargets) closeDiscussion(false)
    setFocusMode(false); setPanelOpen(true); setTab(nextTab); setDocked(false)
    if (nextTab === 'detail') {
      setThreadId(null); setDocked(false)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.inspector-body')?.scrollTo({ top: 0 }))
    }
  }
  function toggleFocus() {
    closeMenus()
    if (!focusMode && docked) setDocked(false)
    setFocusMode(current => !current)
  }
  async function switchRound(round: number) {
    if (round === activeRound) return
    try {
      const document = round !== session.session?.round ? await session.loadSnapshot(round) : review
      const keepThread = panelOpen && tab === 'detail' && selectedComments.some(comment => comment.id === threadId)
      const targets = keepThread ? selection.filter(target => targetExists(document, target)) : []
      if (keepThread && !targets.length) { setTab('comments'); setFilter('all') }
      setViewRound(round); setSelection(targets); closeComposer(false); setContinuous(false); setSubmitting(false)
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
  const openComposer = useCallback((targets: Target[], at?: { x: number; y: number }, replyTo?: string, inDiscussion = false) => {
    if (historical) { setStatus('历史流程只读，请回到当前版本继续讨论。'); return }
    try {
      const key = draftKey(review, targets, replyTo)
      const existing = draftsRef.current.find(item => item.key === key)
      const draft = existing ?? makeDraft(review, targets, '', replyTo)
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (!inDiscussion) { setDiscussionTargets(null); setPoint(at) }
      setComposer(draft); setDocked(!!replyTo && !inDiscussion)
      if (replyTo && !inDiscussion) { setFocusMode(false); setPanelOpen(true); setTab('comments') }
      setStatus('')
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法打开编辑器') }
  }, [review, historical])
  const openDiscussionComposer = useCallback((targets: Target[], at?: { x: number; y: number }, replyTo?: string) => {
    openComposer(targets, at, replyTo, true)
    if (replyTo) setThreadId(replyTo)
  }, [openComposer])
  const openThread = useCallback((id: string, at?: { x: number; y: number }, target?: Target | Target[]) => {
    const comment = review.comments.find(item => item.id === id)
    if (!comment) return
    closeComposer(false); setThreadId(id)
    if (at) {
      const targets = target ? Array.isArray(target) ? target : [target] : comment.targets
      discussionOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDiscussionTargets(targets); setPoint(at); setDocked(false); setContinuous(false)
      setSelection(targets.filter(item => (item.kind === 'node' || item.kind === 'edge') && targetExists(displayReview, item) && targetSceneId(displayReview, item) === scene.id))
    } else {
      setDiscussionTargets(null); setFilter('all'); setTab('comments'); setFocusMode(false); setPanelOpen(true)
      void showTargets(comment.targets)
    }
  }, [review, displayReview, scene.id, closeComposer, showTargets])
  function startReview() {
    if (!unresolved.length) return
    const ordered = [...unresolved.filter(item => item.status === 'needs-review'), ...unresolved.filter(item => item.status === 'open')]
    reviewQueue.current = ordered.map(item => item.id)
    setSubmitting(false); setContinuous(!reviewBlocked); openThread(ordered[0].id)
  }
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
    if (next.id !== latestReview.current.id) setFilter(null)
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
      if (SESSION_ID) await session.finish('approval')
      else {
        const record = createApprovalRecord(review)
        setHistory(parseRecordHistory([...history, record]))
        download(JSON.stringify(record, null, 2), `${filename(review.id)}-${record.id}.approval.json`)
      }
      setSubmitting(false); setStatus('已记录整轮通过。此记录仅对应当前流程快照。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '通过记录生成失败') }
    finally { setSessionAction(false) }
  }

  const taskManager = <dialog ref={tasksDialog} className="task-manager" aria-labelledby="task-manager-title" onCancel={event => { event.preventDefault(); setTasksOpen(false) }}>
    <header className="task-manager-heading"><h2 id="task-manager-title">评审任务</h2><button className="button icon-button" aria-label="关闭评审任务" onClick={() => setTasksOpen(false)}><X size={16} /></button></header>
    <p>每个任务独立保存目的、批注和轮次。更换审查目的时，请建立新任务。</p>
    {taskError && <p className="task-error" role="alert">{taskError}</p>}
    {session.session && <section className="detail-section"><h3>当前任务</h3><p>{session.session.scope?.purpose ?? '旧任务未单独记录审查目的'}</p>{session.session.scope?.context && <p className="muted">关联会话：{session.session.scope.context}</p>}<p className="muted">{session.session.cleanupPolicy === 'archive-on-approval' ? 'Agent 收到最终通过结果后自动归档' : '完成后手动清理'}</p></section>}
    <details className="new-task" open={!SESSION_ID}><summary>基于当前流程建立任务</summary><form className="task-form" onSubmit={event => { event.preventDefault(); void startSession() }}>
      <label htmlFor="task-purpose">审查目的</label><textarea id="task-purpose" required maxLength={10000} rows={2} value={taskPurpose} onChange={event => setTaskPurpose(event.target.value)} placeholder="例如：只核对票券扣除时机与失败分支" />
      <label htmlFor="task-context">关联会话（可选）</label><input id="task-context" maxLength={1000} value={taskContext} onChange={event => setTaskContext(event.target.value)} placeholder="同一段 Agent 对话或工作事项" />
      <label className="task-check"><input type="checkbox" checked={taskAutoArchive} onChange={event => setTaskAutoArchive(event.target.checked)} />Agent 收到最终通过结果后自动归档</label>
      <p className="muted">沿用当前流程图，批注与评审历史从空白开始。原任务和草稿保留。</p>
      <button className="button primary" type="submit" disabled={sessionAction || taskBusy || (!!SESSION_ID && session.availability !== 'active') || !taskPurpose.trim()}>{sessionAction ? '正在建立…' : '建立独立评审'}</button>
    </form></details>
    <section className="task-list" aria-label="独立评审任务列表"><div className="task-manager-heading"><h3>相关任务</h3><button className="button" disabled={taskBusy} onClick={() => void refreshTasks()}>{taskBusy ? '正在读取…' : '刷新任务列表'}</button></div>
      {!tasks.length && !taskBusy && <p className="muted">尚无相关任务。</p>}
      {tasks.map(task => <article className="task-entry" key={task.id} aria-label={task.scope?.purpose ?? task.title}>
        <strong>{task.scope?.purpose ?? task.title}{task.id === SESSION_ID ? ' · 当前任务' : ''}</strong>{task.scope?.purpose && <p>{task.title}</p>}
        <p className="muted">R{task.round} · {task.archivedAt ? '已归档' : phaseLabels[task.phase]}{task.scope?.context ? ` · ${task.scope.context}` : ''}</p>
        <div className="task-actions">{task.archivedAt ? <button className="button" disabled={taskBusy} onClick={() => void restoreTask(task)}>恢复任务</button> : <a className="button" href={`/?session=${encodeURIComponent(task.id)}`}>打开任务</a>}
          <details className="task-options"><summary className="button subtle">更多操作</summary><div>
            <button className="button" disabled={taskBusy} onClick={() => { setTaskError(''); void downloadTask(task).catch(error => setTaskError(error instanceof Error ? error.message : '备份失败')) }}>下载完整备份</button>
            {!task.archivedAt && task.phase === 'approved' && <button className="button" disabled={taskBusy} onClick={() => void cleanTask(task, 'archive')}>备份并归档</button>}
            {(task.archivedAt || task.phase === 'approved') && <button className="button" disabled={taskBusy} onClick={() => setDeletingTask(task.id)}>永久删除</button>}
          </div></details>
        </div>
        {deletingTask === task.id && <div className="task-delete-confirm" role="group" aria-label="确认删除评审任务"><p>将永久删除此任务的流程、批注和历史。会先发起完整备份下载；删除后无法从服务端恢复。</p><div className="task-actions"><button className="button" disabled={taskBusy} onClick={() => void cleanTask(task, 'delete')}>确认永久删除</button><button className="button" onClick={() => setDeletingTask(null)}>取消删除</button></div></div>}
      </article>)}
    </section>
  </dialog>

  if (SESSION_ID && session.availability !== 'active') return <main className="session-loading"><h1>{session.availability === 'archived' ? '评审任务已归档' : '评审任务不存在或已删除'}</h1><p>{session.availability === 'archived' ? '活动评审已清理。可以在评审任务中下载备份或恢复归档。' : '这个链接不会重新建立任务。请从评审任务列表打开其他任务。'}</p><button className="button" onClick={openTasks}>管理评审任务</button>{drafts.length > 0 && <button className="button" onClick={() => download(JSON.stringify(drafts, null, 2), 'logic-margin-drafts.json')}>导出本机草稿</button>}{session.pendingRecovery && <button className="button" onClick={() => download(session.pendingRecovery!, 'logic-margin-unsent.json')}>导出未同步意见</button>}<a href="/">打开本机评审</a>{taskManager}</main>
  if (SESSION_ID && !session.ready) return <main className="session-loading"><h1>LogicMargin</h1><p role={session.error ? 'alert' : 'status'}>{session.error || '正在恢复评审会话…'}</p>{session.error && <button className="button" onClick={session.retry}>重新连接</button>}{session.pendingRecovery && <><button className="button" onClick={() => download(session.pendingRecovery!, 'logic-margin-unsent.json')}>导出未同步意见</button><button className="button" disabled={session.busy} onClick={() => void backupAndRecoverSession()}>备份未同步意见并恢复服务端版本</button></>}<a href="/">打开本机评审</a>{taskManager}</main>

  const threadProps = {
    review, session: session.session, snapshots: session.snapshots, changes,
    threadId, continuous, historical, reviewBlocked, sessionBlocked, viewRound: activeRound,
    setThreadId, showTargets, openComposer, closeComposer, reviewNext,
  }
  const scopeButtons = <>
    <button className="button" onClick={() => { closeMenus(); openComposer([{ kind: 'scene', id: scene.id }]) }}>批注此场景</button>
    <button className="button" onClick={() => { closeMenus(); openComposer([{ kind: 'review', id: review.id }]) }}>批注整个评审</button>
  </>

  return <div className={`app-shell ${focusMode ? 'is-focused' : ''}`}>
    <header className="topbar">
      <button className="button icon-button nav-toggle" data-keep-composer aria-label={navOpen ? '收起场景导航' : '展开场景导航'} aria-expanded={navOpen} aria-controls="scene-navigation" onClick={() => setNavOpen(current => !current)}>{navOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
      <span className="brand-mark" title="LogicMargin · 逻辑旁批"><img src={logoUrl} alt="LogicMargin" width="28" height="28" /></span>
      <h1 className="review-title" title={review.title}>{review.title}</h1>
      <details ref={infoRef} className="workspace-menu review-tools"><summary className="button" aria-label="评审信息"><Info size={15} /><span className="button-text">评审信息</span><ChevronDown className="menu-chevron" size={12} aria-hidden="true" /></summary>
        <div className="review-info-card"><h2>评审说明</h2><p className="document-description">{review.description}</p>
          {session.session && <section className="detail-section" aria-label="代理评审会话"><h3>第 {session.session.round} 轮 · {phaseLabels[session.session.phase]}</h3><p>审查目的：{session.session.scope?.purpose ?? '旧任务未单独记录'}</p><p>批注保存到服务端，提交本轮后交给代理处理。</p></section>}
          <div className="document-meta"><span className="badge">{review.revision}</span>{review.snapshot.dirty && <span className="badge warning">包含未提交改动</span>}{approved && <span className="badge">本轮已通过</span>}</div>
          {!!(changes.added.length + changes.changed.length + changes.removed.length) && <div className="revision-banner"><strong>已载入新版流程</strong><p>新增 {changes.added.length} 项 · 变化 {changes.changed.length} 项 · 移除 {changes.removed.length} 项。原批注已保留，请复核受影响意见。</p></div>}
          <h3>已展示</h3><ul className="coverage-list">{review.coverage.included.map(item => <li key={item}>{item}</li>)}</ul>{!!review.coverage.excluded.length && <><h3>尚未覆盖</h3><ul className="coverage-list">{review.coverage.excluded.map(item => <li key={item}>{item}</li>)}</ul></>}<p>{review.coverage.note}</p>
          <details className="technical-info"><summary>技术信息</summary><p>{review.snapshot.repository}<br />代码 {review.snapshot.commit}<br />采集于 {new Date(review.snapshot.capturedAt).toLocaleString('zh-CN')}</p><p>快照指纹 <code>{review.snapshot.fingerprint}</code></p>{session.session && <><p>任务 ID <code>{session.session.id}</code></p>{session.session.scope?.context && <p>关联会话：{session.session.scope.context}</p>}</>}</details>
        </div>
      </details>
      <div className="topbar-actions"><span className={`save-state ${displaySaveState.includes('失败') ? 'save-error' : ''}`} role="status"><Circle size={7} fill="currentColor" />{displaySaveState}</span>
        <input className="screen-reader-only" ref={inputRef} type="file" accept=".json,application/json" aria-label="导入评审文件" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} />
        <details className="workspace-menu file-menu"><summary className="button">文件<ChevronDown className="menu-chevron" size={12} aria-hidden="true" /></summary><div className="menu-content">
          {!SESSION_ID && <button className="button" onClick={() => { closeMenus(); inputRef.current?.click() }}><Upload size={15} />导入评审</button>}
          <button className="button" onClick={() => { closeMenus(); download(serializeReview(review), `${filename(`${review.id}-${review.revision}`)}.logic-margin.json`) }}><ArrowDownToLine size={15} />导出评审</button>
          {!SESSION_ID && HAS_BUNDLED_SPIRIT_REVIEW && <button className="button" disabled={loadingSpiritSanctum} aria-busy={loadingSpiritSanctum} onClick={() => { closeMenus(); void openSpiritSanctum() }}>{loadingSpiritSanctum ? '正在打开魔灵秘境…' : '打开魔灵秘境评审'}</button>}
          {!SESSION_ID && review.id !== sampleReview.id && <button className="button" onClick={() => { closeMenus(); void importFile(new File([JSON.stringify(sampleReview)], 'sample.json')) }}>打开 Vast 样例</button>}
          <button className="button" onClick={openTasks}>评审任务</button>
          {SESSION_ID && <button className="button" onClick={() => { closeMenus(); void backupFullSession() }}>备份完整会话</button>}
          {!SESSION_ID && !!history.length && <button className="button" onClick={() => { closeMenus(); archiveHistory() }}>导出并归档全部历史</button>}
          {SESSION_ID && <a className="button" href="/">返回本机评审</a>}
        </div></details>
        {approved ? <span className="badge approval-state" role="status">本轮已通过</span> : !historical && <button className="button primary" disabled={sessionBlocked || sessionAction || (!hasFeedback && !unresolved.length && !canApprove)} onClick={() => { closeComposer(false); if (!hasFeedback && unresolved.length) startReview(); else setSubmitting(true) }}>{finishLabel}{pending.length ? `（${pending.length}）` : ''}</button>}
      </div>
    </header>
    {taskManager}
    <div className="workspace-notifications">
      {session.error && <div className="notice error" role="alert"><p>{session.error}</p><button className="button" onClick={session.retry}>重新连接</button>{session.pendingRecovery && <><button className="button" onClick={() => download(session.pendingRecovery!, 'logic-margin-unsent.json')}>导出未同步意见</button><button className="button" disabled={session.busy} onClick={() => void backupAndRecoverSession()}>备份未同步意见并恢复服务端版本</button></>}</div>}
      {focusMode && displaySaveState.includes('失败') && <div className="notice error" role="alert"><p>{displaySaveState}</p><button className="button" onClick={() => download(serializeReview(review), `${filename(`${review.id}-${review.revision}`)}.logic-margin.json`)}>导出评审</button></div>}
      {notice && <div className="notice error" role="alert"><p>{notice}</p><button className="icon-button button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {status && <div className="notice status-notice" role="status"><p>{status}</p><button className="icon-button button" aria-label="关闭状态提示" onClick={() => setStatus('')}><X size={16} /></button></div>}
      {Object.entries(recovery).map(([key, raw]) => raw !== null && <div className="notice error" key={key}><p>{key === 'review' ? '自动保存已暂停，避免覆盖损坏的记录。' : `${key === 'drafts' ? '草稿' : '评审历史'}原始数据已保留，自动保存暂停。`}</p><button className="button" onClick={() => { download(raw, `logic-margin-${key}-recovery.txt`, 'text/plain'); setRecovery(current => ({ ...current, [key]: null })); setNotice('') }}>{key === 'review' ? '备份原记录并启用保存' : `备份${key === 'drafts' ? '草稿' : '历史'}原记录并启用保存`}</button></div>)}
      {draftSaveError && <div className="notice error" role="alert"><p>{draftSaveError}</p><button className="button" onClick={() => download(JSON.stringify(drafts, null, 2), 'logic-margin-drafts.json')}>导出草稿</button></div>}
      {historySaveError && <div className="notice error" role="alert"><p>{historySaveError}</p><button className="button" onClick={() => download(JSON.stringify(history, null, 2), 'logic-margin-record-history.json')}>导出评审记录</button></div>}
    </div>
    <div className={`workspace ${panelOpen ? 'panel-open' : 'panel-closed'} ${navOpen ? 'nav-open' : 'nav-collapsed'}`}>
      <button className="nav-shade" aria-label="关闭场景导航" onClick={() => setNavOpen(false)} />
      <aside id="scene-navigation" className="sidebar" aria-label="评审场景"><div className="navigation-heading"><span>流程场景</span><span>{displayReview.scenes.length}</span></div>
        <nav>{displayReview.scenes.map((item, index) => <button key={item.id} className={`scene-button ${scene.id === item.id ? 'active' : ''}`} onClick={() => switchScene(item.id)} aria-current={scene.id === item.id ? 'page' : undefined}><span className="scene-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{displayReview.nodes.filter(node => node.sceneId === item.id).length} 个步骤</small></span><ChevronRight size={14} /></button>)}</nav>
      </aside>
      <main className="review-main">
        <div className="graph-toolbar">
          <div className="scene-context"><h2 className="scene-title" title={`${scene.title} · ${scene.description}`}>{scene.title}</h2><label className="mobile-scene-select"><select aria-label="场景" value={scene.id} onChange={event => switchScene(event.target.value)}>{displayReview.scenes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
          <button className={`button panel-toggle ${panelOpen ? 'active' : ''}`} data-keep-composer aria-label={`评审面板${review.comments.length ? ` ${review.comments.length}` : ''}`} aria-expanded={panelOpen} aria-controls="node-inspector" onClick={() => { if (panelOpen) { setPanelOpen(false); if (docked) closeComposer(false) } else openPanel(tab) }}><MessageSquare size={14} /><span className="panel-label">评审面板</span>{review.comments.length > 0 && <span className="panel-count">{review.comments.length}</span>}</button>
          <details className={`canvas-tools${compactToolbar ? ' workspace-menu' : ''}`} open={!compactToolbar}>
            <summary className="button" aria-label="画布工具"><SlidersHorizontal size={15} />工具{mode === 'select' && <span className="badge">框选中</span>}<ChevronDown className="menu-chevron" size={12} aria-hidden="true" /></summary>
            <div className="canvas-tool-content" onClick={event => { if (compactToolbar && (event.target as Element).closest('button')) closeMenus() }}>
              {session.session && <RevisionControls session={session.session} viewRound={activeRound} onViewRound={switchRound} onOpenChanges={() => openPanel('changes')} />}
              <div className="tool-group canvas-mode-switch" role="group" aria-label="画布操作模式"><button className={`button ${mode === 'pan' ? 'active' : ''}`} aria-label="浏览" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}><Hand size={14} /><span className="tool-label">浏览</span></button><button className={`button ${mode === 'select' ? 'active' : ''}`} aria-label="框选" aria-pressed={mode === 'select'} onClick={() => setMode('select')}><Scan size={14} /><span className="tool-label">框选</span></button></div>
              <div className="tool-group toolbar-actions">
                {!historical && (compactToolbar
                  ? <div className="scope-actions-inline" role="group" aria-label="批注范围"><span className="project-label">范围批注</span>{scopeButtons}</div>
                  : <details className="workspace-menu scope-actions"><summary className="button">添加批注<ChevronDown className="menu-chevron" size={12} aria-hidden="true" /></summary><div className="menu-content">{scopeButtons}</div></details>)}
                {!!selection.length && <><button className="button icon-button locate-selection" data-keep-composer aria-label="定位当前选择" title="定位当前选择" onClick={() => graph.current?.focusTargets(selection)}><Focus size={16} /></button><button className="button mobile-clear-selection" onClick={() => setSelection([])}><X size={14} />清除选择</button></>}
                <button className="button focus-toggle" data-keep-composer aria-label={focusMode ? '退出专注' : '专注画布'} aria-pressed={focusMode} onClick={toggleFocus}><Maximize2 size={15} /><span className="focus-label">{focusMode ? '退出专注' : '专注画布'}</span></button>
              </div>
            </div>
          </details>
        </div>
        {submitting && <section className="feedback-summary" aria-label={hasFeedback ? '提交本轮意见' : finishLabel}>
          <h3>{hasFeedback ? SESSION_ID ? '提交本轮意见' : '生成本轮意见包' : finishLabel}</h3>
          {hasFeedback && <p>{pending.length} 条新意见 · {currentDrafts.length} 份本版本草稿。</p>}
          {hasFeedback && <p>{SESSION_ID ? '提交会固定当前流程与源码版本，并通知等待中的代理。' : '意见包固定当前流程与源码版本，生成后需要交给代理。'}</p>}
          {needsReviewCount > 0 && <p>{needsReviewCount} 条意见待复核。请核对新版流程与代理回复，再确认已解决或仍需处理。仍需处理的意见可再次提交给代理。</p>}
          {currentDrafts.length > 0 && <p>{hasFeedback ? '草稿可以先保存后提交，也可以留到下一轮；旧版本草稿始终保留。' : `${currentDrafts.length} 份草稿将继续保留，不会随本次完成审查提交或清除。`}</p>}
          {!unresolved.length && <p>当前流程没有尚待处理的意见。确认后将保存本轮通过记录{SESSION_ID ? '，并通知等待中的代理。' : '。'}</p>}
          <div className="tool-group">
            {needsReviewCount > 0 && <button className="button primary" disabled={reviewBlocked} onClick={startReview}>开始逐条复核</button>}
            {hasFeedback && currentDrafts.length > 0 && <button className="button primary" disabled={sessionBlocked || historical || sessionAction} onClick={() => void generateFeedback(true)}>保存草稿并提交</button>}
            {hasFeedback && <button className={`button ${currentDrafts.length ? '' : 'primary'}`} disabled={sessionBlocked || historical || sessionAction || !pending.length} onClick={() => void generateFeedback(false)}>{sessionAction ? '正在提交…' : currentDrafts.length ? '仅提交已保存意见' : SESSION_ID ? '提交给代理' : '生成意见包'}</button>}
            {!unresolved.length && <button className="button primary" disabled={!canApprove} onClick={() => void approve()}>{sessionAction ? '正在确认…' : '确认整轮通过'}</button>}
            <button className="button" onClick={() => setSubmitting(false)}>取消</button>
          </div>
        </section>}
        {publicationPending && <div className="revision-banner publication-pending" role="status"><strong>修改中，新版尚未发布</strong><p>当前仍是 R{session.session?.round} 的流程图。代理交流回复不代表修改已完成；新版发布后才能确认处理结果。</p></div>}
        {historical && <div className="revision-banner historical-banner"><span>正在查看 R{activeRound} 的历史流程 · 只读。</span><button className="button subtle" onClick={() => void switchRound(session.session!.round)}>返回当前 R{session.session?.round}</button></div>}
        <GraphCanvas ref={graph} key={canvasKey} review={displayReview} sceneId={scene.id} selection={selection} setSelection={graphSelection} changes={graphChanges} mode={mode}
          nodeAppearance={nodeAppearance} onNodeAppearanceChange={changeNodeAppearance}
          readOnly={historical} viewportKey={canvasKey} changeSide={historical ? 'before' : 'after'} commentOrder={commentOrder}
          onOpenComposer={openComposer} onOpenThread={openThread} onViewportChange={reposition} />
        <div className="canvas-caption"><span className="selection-count">{selection.length ? `已选 ${selection.length} 项` : '选择步骤或连线'}</span><span className="canvas-help">右键批注 · 滚轮缩放 · 更多操作见图例</span><span>{unresolved.length} 条待处理意见</span></div>
      </main>
      <aside id="node-inspector" className={`inspector ${panelOpen ? 'is-open' : ''}`} aria-label="步骤详情与批注">
        <div className="inspector-tabs" role="group" aria-label="评审面板内容" data-keep-composer><button className={tab === 'comments' ? 'active' : ''} aria-pressed={tab === 'comments'} onClick={() => openPanel('comments')}>讨论 {review.comments.length}</button><button className={tab === 'detail' ? 'active' : ''} aria-pressed={tab === 'detail'} onClick={() => openPanel('detail')}>详情</button>{(drafts.length > 0 || tab === 'drafts') && <button className={tab === 'drafts' ? 'active' : ''} aria-pressed={tab === 'drafts'} onClick={() => openPanel('drafts')}>草稿 {drafts.length}</button>}{baseline && <button className={tab === 'changes' ? 'active' : ''} aria-pressed={tab === 'changes'} onClick={() => openPanel('changes')}>变化</button>}<button className="button icon-button" aria-label="收起侧栏" onClick={() => { setPanelOpen(false); if (docked) closeComposer() }}><X size={16} /></button></div>
        <div className="inspector-body" hidden={!!composer && docked}>
          {tab === 'changes' && !baseline && <div className="empty-state"><p>正在读取修改前流程…</p><button className="button" onClick={() => void session.loadSnapshot(baselineRound).catch(error => setNotice(error instanceof Error ? error.message : '历史读取失败'))}>重新读取</button></div>}
          {tab === 'changes' && baseline && sessionChanges && <>
            <section className="detail-section publication-summary"><h3>R{baseline.round} → R{session.session?.round}</h3><p>{publication?.summary ?? '此轮由旧版客户端发布，未记录发布说明。'}</p>{publication?.unchangedReason && <p>流程未变原因：{publication.unchangedReason}</p>}{publication && <p className="muted">已核验 {publication.source.files.length} 个源文件 · {new Date(publication.source.checkedAt).toLocaleString('zh-CN')}</p>}</section>
            <RevisionChangesPanel before={baseline.review} after={review} changes={sessionChanges} onLocate={(target, side) => showTargets([target], side === 'before' ? baseline.round : session.session!.round)} />
          </>}
          {tab === 'detail' && <>
            {!selection.length ? <div className="empty-state"><MousePointer2 size={24} /><h3>选择一个步骤</h3><p>点击图中步骤或连线，查看规则与源码依据。</p></div> : <div className="inspector-heading"><span className="project-label">{selectedNode ? kindLabels[selectedNode.kind] : selectedEdge ? '连线与条件' : `已选 ${selection.length} 项`}</span><h3 className="panel-title">{selectedNode?.title ?? selectedEdge?.label ?? '这一段流程'}</h3></div>}
            {selectedNode && <>
              {selectedNode.detail && selectedNode.detail !== selectedNode.summary && <section className="detail-section"><h3>规则说明</h3><p>{selectedNode.detail}</p></section>}
              {(selectedNode.input || selectedNode.output) && <details className="detail-section data-details"><summary>输入与输出</summary><div className="state-change"><div><span>输入</span><strong>{selectedNode.input || '未提供'}</strong></div><ArrowRight size={16} /><div><span>输出</span><strong>{selectedNode.output || '未提供'}</strong></div></div></details>}
              {!!selectedNode.evidence.length && <details className="evidence"><summary>源码依据 · {selectedNode.evidence.length} 处</summary>{selectedNode.evidence.map(item => <div key={`${item.path}:${item.startLine}`} className="source-item"><code>{item.symbol}</code><small>{item.path}:{item.startLine}–{item.endLine}</small></div>)}</details>}
            </>}
            {selectedEdge && <section className="detail-section"><h3>流转条件</h3><p>{selectedEdge.detail}</p><p>{targetLabel(displayReview, { kind: 'node', id: selectedEdge.source })} → {targetLabel(displayReview, { kind: 'node', id: selectedEdge.target })}</p></section>}
            {selection.length > 1 && <div className="selection-list">{selection.map(target => <div className="selection-item" key={keyOf(target)}><span>{targetLabel(displayReview, target)}</span><button className="button icon-button" aria-label={`移除选择：${targetLabel(displayReview, target)}`} onClick={() => setSelection(current => current.filter(item => keyOf(item) !== keyOf(target)))}><X size={13} /></button></div>)}</div>}
            {selectedComments.length > 0 && <section className="detail-section target-discussions" aria-label="所选对象的相关讨论"><button className="button" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openThread(selectedComments[0].id, { x: rect.left, y: rect.bottom }, selection) }}><MessageSquare size={14} />查看相关讨论 {selectedComments.length}</button></section>}
          </>}
          {tab === 'comments' && <>
            {!!review.comments.length && <div className="review-navigation"><p>{unresolved.length} 条尚未确认{pending.length > 0 && ` · ${pending.length} 条可提交`}</p>{!continuous && !reviewBlocked && unresolved.length > 0 && <button className="button" onClick={startReview}>开始逐条复核</button>}{continuous && <button className="button subtle" onClick={() => setContinuous(false)}>退出连续复核</button>}</div>}
            {!!review.comments.length && <div className="comment-filter" aria-label="筛选批注">{(['all', 'open', 'needs-review', 'resolved'] as const).map(item => <button key={item} className={activeFilter === item ? 'active' : ''} aria-pressed={activeFilter === item} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : statusLabels[item]} <span className="filter-count">{commentCounts[item]}</span></button>)}</div>}
            {!visibleComments.length && <div className="empty-state"><MessageSquare size={24} /><h3>{review.comments.length ? '此状态下暂无批注' : '让意见落在具体流程上'}</h3><p>在图中选择步骤、连线或一段流程，也可以批注遗漏的场景。</p></div>}
            <CommentThreads {...threadProps} comments={visibleComments} openThread={openThread} />
            {SESSION_ID ? !!session.session?.history.length && <details className="record-list"><summary>会话评审记录 · {session.session.history.length}</summary>{session.session.history.slice().reverse().map(record => <div className="draft-entry" key={record.id}><strong>{record.kind === 'logic-margin-feedback' ? '已提交的意见包' : '整轮通过记录'}</strong><small>R{record.round} · {record.revision} · {new Date(record.createdAt).toLocaleString('zh-CN')}</small><button className="button" onClick={() => void downloadRecord(record.id)}>下载固定记录</button></div>)}</details> : !!history.filter(record => record.review.id === review.id).length && <details className="record-list"><summary>本地评审记录 · {history.filter(record => record.review.id === review.id).length}</summary>{history.filter(record => record.review.id === review.id).slice().reverse().map(record => <div className="draft-entry" key={record.id}><strong>{record.kind === 'logic-margin-feedback' ? '意见包 · 待交给代理' : '整轮通过记录'}</strong><small>{record.review.revision} · {new Date(record.createdAt).toLocaleString('zh-CN')}</small><button className="button" onClick={() => download(JSON.stringify(record, null, 2), `${filename(record.review.id)}-${record.id}.json`)}>下载固定记录</button></div>)}</details>}
          </>}
          {tab === 'drafts' && <section className="draft-list"><p className="muted">未保存的内容自动保留。旧版本草稿可导出核对。</p>{!drafts.length && <div className="empty-state"><p>没有未保存的意见。</p></div>}{drafts.map(draft => {
            const valid = validDrafts.some(item => item.key === draft.key)
            return <article className="draft-entry" key={draft.key}><strong>{draft.replyTo ? '讨论回复 · ' : ''}{draft.labels.join(' · ')}</strong><small>{draft.revision}{!valid && ' · 旧版本或原目标不可用'}</small><p>{draft.body}</p>
              <div className="tool-group">{valid && <button className="button" disabled={historical} onClick={() => { showTargets(draft.targets); openComposer(draft.targets, undefined, draft.replyTo); setDocked(true); setPanelOpen(true) }}>继续编辑</button>}
                <details className="draft-options"><summary className="button subtle">更多操作</summary><div><button className="button" onClick={() => download(JSON.stringify(draft, null, 2), `logic-margin-draft-${filename(draft.revision)}.json`)}>导出这份草稿</button><button className="button subtle" onClick={() => { download(JSON.stringify(draft, null, 2), `logic-margin-draft-${filename(draft.revision)}.json`); remember({ ...draft, body: '' }) }}>导出并移除草稿</button></div></details>
              </div>
            </article>
          })}{drafts.length > 1 && <button className="button" onClick={() => download(JSON.stringify(drafts, null, 2), 'logic-margin-drafts.json')}>导出全部草稿</button>}</section>}
        </div>
        <CommentComposer draft={composer} docked={docked} position={position}
          discussion={discussionTargets ? {
            key: discussionTargets.map(keyOf).join('|'),
            content: <>{historical && <p className="muted">历史流程只读，讨论显示当前处理状态。</p>}<CommentThreads {...threadProps} idPrefix="discussion-thread" comments={discussionComments} openComposer={openDiscussionComposer} continuous={false} /></>,
            replyLabel: composer?.replyTo ? `回复意见 #${review.comments.findIndex(comment => comment.id === composer.replyTo) + 1}` : undefined,
          } : undefined}
          onChange={body => { if (composer) { const next = { ...composer, body, updatedAt: new Date().toISOString() }; setComposer(next); remember(next) } }} onSave={saveComposer} onClose={() => discussionTargets ? closeDiscussion() : closeComposer()} onToggle={() => { setDocked(current => !current); if (!docked) { setFocusMode(false); setPanelOpen(true); showTargets(composer?.targets ?? []) } }} />
      </aside>
    </div>
  </div>
}
