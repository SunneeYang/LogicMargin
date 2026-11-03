import { useCallback, useEffect, useRef, useState } from 'react'
import { newId } from './id.ts'
import { parsePendingSession, pendingMatchesSession, reviewMutations, sameVisibleReview, currentRequest as sessionRequest, snapshotRequest, SessionRequestError } from './session-client.ts'
import type { PendingSession } from './session-client.ts'
import type { CurrentSession, SessionOptions } from './session-types.ts'
import type { ReviewDocument } from './types.ts'

const message = (error: unknown) => error instanceof Error ? error.message : '会话同步失败'
const stalePending = '流程轮次已更新，未同步意见已保留；请先导出备份，再恢复当前服务端版本'

export function useReviewSession(sessionId: string | null, onSession: (session: CurrentSession) => void) {
  const [session, setSession] = useState<CurrentSession | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingRecovery, setPendingRecovery] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [availability, setAvailability] = useState<'active' | 'archived' | 'deleted'>('active')
  const watchController = useRef<AbortController | null>(null)
  const onSessionRef = useRef(onSession)
  onSessionRef.current = onSession
  const current = useRef<CurrentSession | null>(null)
  const displayed = useRef<CurrentSession | null>(null)
  const pending = useRef<PendingSession | null>(null)
  const corrupt = useRef(false)
  const recovering = useRef(false)
  const task = useRef<Promise<CurrentSession> | null>(null)
  const alive = useRef(false)
  const generation = useRef(0)
  const readyRef = useRef(false)
  const [snapshots, setSnapshots] = useState(new Map<number, ReviewDocument>())
  const snapshotCache = useRef(new Map<number, ReviewDocument>())
  const snapshotTasks = useRef(new Map<number, Promise<ReviewDocument>>())
  const key = `logic-margin:session:${sessionId}:pending`
  const publish = useCallback((next: CurrentSession, optimisticReview?: ReviewDocument) => {
    if (!alive.current) return
    displayed.current = next
    setSession(next)
    onSessionRef.current(optimisticReview ? { ...next, review: optimisticReview } : next)
  }, [])
  const store = useCallback((next: PendingSession | null) => {
    try {
      if (next?.batches.length) localStorage.setItem(key, JSON.stringify(next))
      else localStorage.removeItem(key)
    } catch { throw new Error('待同步批注无法保存到本机，请导出当前评审后再离开') }
    pending.current = next?.batches.length ? next : null
    setPendingCount(next?.batches.length ?? 0)
    setPendingRecovery(pending.current ? JSON.stringify(pending.current, null, 2) : null)
  }, [key])
  const flush = useCallback((): Promise<CurrentSession> => {
    if (task.current) return task.current
    if (!sessionId || !readyRef.current || !current.current) return Promise.reject(new Error('评审会话尚未连接'))
    if (corrupt.current) return Promise.reject(new Error('待同步记录损坏，请先下载备份；原始数据已保留'))
    const started = generation.current
    const operation = async () => {
      setBusy(true)
      try {
        while (pending.current?.batches.length) {
          if (!current.current || !pendingMatchesSession(pending.current, current.current)) throw new Error(stalePending)
          const batch = pending.current.batches[0]
          const next = await sessionRequest(`/${encodeURIComponent(sessionId)}/mutations`, batch)
          if (generation.current !== started) throw new Error('会话已切换，待同步记录保留在原会话')
          if (!next) throw new Error('会话服务未返回保存结果')
          if (!current.current || next.version >= current.current.version) current.current = next
          const remaining = pending.current.batches.slice(1)
          store(remaining.length ? { ...pending.current, batches: remaining } : null)
        }
        setError('')
        publish(current.current!)
        return current.current!
      } catch (error) { if (generation.current === started) setError(message(error)); throw error }
      finally { if (generation.current === started) { setBusy(false); task.current = null } }
    }
    task.current = Promise.resolve().then(operation)
    return task.current
  }, [sessionId, publish, store])

  useEffect(() => {
    alive.current = true
    generation.current++
    current.current = null; displayed.current = null; pending.current = null; task.current = null
    snapshotCache.current = new Map(); snapshotTasks.current = new Map(); setSnapshots(new Map())
    setSession(null); setError(''); setBusy(false); setPendingCount(0); setPendingRecovery(null); setAvailability('active')
    readyRef.current = false
    setReady(false)
    if (!sessionId) return () => { alive.current = false }
    const controller = new AbortController()
    watchController.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
      pending.current = raw ? parsePendingSession(raw) : null
      corrupt.current = false
      setPendingCount(pending.current?.batches.length ?? 0)
      setPendingRecovery(raw)
    } catch (error) { corrupt.current = true; setPendingRecovery(raw); setError(message(error)) }
    async function watch() {
      while (!controller.signal.aborted) {
        try {
          const query = readyRef.current && current.current ? `?afterVersion=${current.current.version}&waitMs=25000` : ''
          const next = await sessionRequest(`/${encodeURIComponent(sessionId!)}${query}`, undefined, controller.signal)
          if (next && (!current.current || next.version >= current.current.version)) {
            current.current = next
            if (pending.current && !pendingMatchesSession(pending.current, next)) {
              readyRef.current = true; setReady(true); publish(next); setError(stalePending)
            } else if (!readyRef.current) {
              readyRef.current = true; setReady(true)
              publish(next, pending.current?.review)
              if (pending.current && !corrupt.current) void flush().catch(() => {})
            } else if (!pending.current && !task.current) { if (!corrupt.current) setError(''); publish(next) }
          }
        } catch (error) {
          if (controller.signal.aborted) break
          if (error instanceof SessionRequestError && (error.status === 404 || error.status === 410)) {
            setAvailability(error.status === 410 ? 'archived' : 'deleted')
            readyRef.current = false; setReady(false); setError('')
            controller.abort(); break
          }
          setError(message(error))
          await new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
        }
      }
    }
    void watch()
    return () => { alive.current = false; readyRef.current = false; generation.current++; controller.abort(); clearTimeout(timer) }
  }, [sessionId, key, flush, publish])

  const enqueue = useCallback((before: ReviewDocument, after: ReviewDocument) => {
    if (!sessionId || !readyRef.current || !displayed.current) throw new Error('评审会话尚未连接')
    if (recovering.current) throw new Error('正在恢复服务端版本，请稍后再添加批注')
    if (corrupt.current) throw new Error('待同步记录损坏，请先下载备份')
    const mutations = reviewMutations(before, after)
    if (!mutations.length) return
    const hasStatus = mutations.some(item => item.kind === 'set-status')
    if (hasStatus && (pending.current || task.current)) throw new Error('上一条批注正在保存，请稍后再确认状态')
    store({ schemaVersion: 1, review: after, batches: [...(pending.current?.batches ?? []), {
      revision: before.revision, fingerprint: before.snapshot.fingerprint,
      round: displayed.current.round,
      ...(hasStatus ? { expectedVersion: displayed.current.version } : {}), mutations,
    }] })
    void flush().catch(() => {})
  }, [sessionId, store, flush])
  const finish = useCallback(async (kind: 'feedback' | 'approval') => {
    const visible = pending.current?.review ?? displayed.current?.review
    const round = displayed.current?.round
    const latest = await flush()
    if (!visible || round !== latest.round || !sameVisibleReview(visible, latest.review)) {
      const error = new Error('会话已有更新，请核对最新流程和批注后再提交')
      setError(error.message)
      throw error
    }
    setBusy(true)
    try {
      const next = await sessionRequest(`/${encodeURIComponent(sessionId!)}/finish`, { expectedVersion: latest.version, kind, submissionId: newId() })
      if (!next) throw new Error('会话服务未返回提交结果')
      if (!current.current || next.version >= current.current.version) current.current = next
      publish(current.current); setError(''); return current.current
    } catch (error) { setError(message(error)); throw error }
    finally { setBusy(false) }
  }, [sessionId, flush, publish])
  const create = useCallback(async (review: ReviewDocument, options: SessionOptions = {}) => {
    setBusy(true)
    try {
      const next = await sessionRequest('', { review, ...options })
      if (!next) throw new Error('会话服务未返回创建结果')
      return next
    } finally { setBusy(false) }
  }, [])
  const retry = useCallback(() => { void flush().catch(() => {}) }, [flush])
  const stop = useCallback((state: 'archived' | 'deleted') => {
    watchController.current?.abort()
    readyRef.current = false; setReady(false); setBusy(false); setError(''); setAvailability(state)
  }, [])
  const recoverRemote = useCallback(async () => {
    if (!sessionId || task.current || recovering.current) throw new Error('请等待当前保存完成后再恢复服务端版本')
    recovering.current = true; setBusy(true)
    try {
      const next = await sessionRequest(`/${encodeURIComponent(sessionId)}`)
      if (!next) throw new Error('会话服务未返回恢复结果')
      store(null); corrupt.current = false
      if (!current.current || next.version >= current.current.version) current.current = next
      readyRef.current = true; setReady(true)
      publish(current.current); setError(''); return current.current
    } finally { recovering.current = false; setBusy(false) }
  }, [sessionId, store, publish])
  const loadSnapshot = useCallback((round: number): Promise<ReviewDocument> => {
    const cached = snapshotCache.current.get(round)
    if (cached) return Promise.resolve(cached)
    const running = snapshotTasks.current.get(round)
    if (running) return running
    if (!sessionId || !current.current?.snapshots.some(item => item.round === round)) return Promise.reject(new Error('找不到这个流程版本'))
    const started = generation.current
    const expectedReviewId = current.current.review.id
    const operation = snapshotRequest(sessionId, round).then(review => {
      if (generation.current !== started) throw new Error('会话已切换')
      if (review.id !== expectedReviewId) throw new Error('历史快照所属评审不一致')
      const next = new Map(snapshotCache.current)
      next.set(round, review)
      if (next.size > 6) next.delete(next.keys().next().value!)
      snapshotCache.current = next; setSnapshots(next)
      return review
    }).finally(() => { if (generation.current === started) snapshotTasks.current.delete(round) })
    snapshotTasks.current.set(round, operation)
    return operation
  }, [sessionId])
  return { session, ready, busy, error, pendingRecovery, availability, stop, enqueue, flush, finish, create, retry, recoverRemote, snapshots, loadSnapshot,
    saveState: error ? '同步暂停' : busy || pendingCount ? '正在同步' : ready ? '已保存到会话' : '正在连接会话' }
}
