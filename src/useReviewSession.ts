import { useCallback, useEffect, useRef, useState } from 'react'
import { newId } from './id.ts'
import { parseReview } from './model.ts'
import { parsePendingSession, reviewMutations, sessionRequest } from './session-client.ts'
import type { PendingSession } from './session-client.ts'
import type { ReviewSession } from './session-types.ts'
import type { ReviewDocument } from './types.ts'

const message = (error: unknown) => error instanceof Error ? error.message : '会话同步失败'

export function useReviewSession(sessionId: string | null, onSession: (session: ReviewSession) => void) {
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingRecovery, setPendingRecovery] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const onSessionRef = useRef(onSession)
  onSessionRef.current = onSession
  const current = useRef<ReviewSession | null>(null)
  const displayed = useRef<ReviewSession | null>(null)
  const pending = useRef<PendingSession | null>(null)
  const corrupt = useRef(false)
  const recovering = useRef(false)
  const task = useRef<Promise<ReviewSession> | null>(null)
  const alive = useRef(false)
  const generation = useRef(0)
  const readyRef = useRef(false)
  const key = `logic-margin:session:${sessionId}:pending`
  const publish = useCallback((next: ReviewSession) => {
    if (!alive.current) return
    displayed.current = next
    setSession(next)
    onSessionRef.current(next)
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
  const flush = useCallback((): Promise<ReviewSession> => {
    if (task.current) return task.current
    if (!sessionId || !readyRef.current || !current.current) return Promise.reject(new Error('评审会话尚未连接'))
    if (corrupt.current) return Promise.reject(new Error('待同步记录损坏，请先下载备份；原始数据已保留'))
    const started = generation.current
    const operation = async () => {
      setBusy(true)
      try {
        while (pending.current?.batches.length) {
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
    setSession(null); setError(''); setBusy(false); setPendingCount(0); setPendingRecovery(null)
    readyRef.current = false
    setReady(false)
    if (!sessionId) return () => { alive.current = false }
    const controller = new AbortController()
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
            if (!readyRef.current) {
              readyRef.current = true; setReady(true)
              publish(pending.current ? { ...next, review: pending.current.review } : next)
              if (pending.current && !corrupt.current) void flush().catch(() => {})
            } else if (!pending.current && !task.current) { if (!corrupt.current) setError(''); publish(next) }
          }
        } catch (error) {
          if (controller.signal.aborted) break
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
    if ((pending.current?.batches.length ?? 0) >= 2000) throw new Error('待同步操作已达上限，请恢复连接后再继续')
    store({ schemaVersion: 1, review: after, batches: [...(pending.current?.batches ?? []), {
      revision: before.revision, fingerprint: before.snapshot.fingerprint,
      ...(hasStatus ? { expectedVersion: displayed.current.version } : {}), mutations,
    }] })
    void flush().catch(() => {})
  }, [sessionId, store, flush])
  const finish = useCallback(async (kind: 'feedback' | 'approval') => {
    const visible = pending.current?.review ?? displayed.current?.review
    const latest = await flush()
    if (!visible || JSON.stringify(parseReview(visible)) !== JSON.stringify(latest.review)) {
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
  const create = useCallback(async (review: ReviewDocument) => {
    setBusy(true)
    try {
      const next = await sessionRequest('', { review })
      if (!next) throw new Error('会话服务未返回创建结果')
      return next
    } finally { setBusy(false) }
  }, [])
  const retry = useCallback(() => { void flush().catch(() => {}) }, [flush])
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
  return { session, ready, busy, error, pendingRecovery, enqueue, flush, finish, create, retry, recoverRemote,
    saveState: error ? '同步暂停' : busy || pendingCount ? '正在同步' : ready ? '已保存到会话' : '正在连接会话' }
}
