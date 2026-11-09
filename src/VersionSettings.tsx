import { useEffect, useState } from 'react'
import { useI18n } from './i18n.ts'

type Runtime = { version: string; local: boolean; canUpdate: boolean; csrfToken?: string }
type Release = { version: string; url: string; newer: boolean }
type Update = { phase: string; version?: string; error?: string; installedVersion?: string; reloadRequired?: boolean }
const phases: Record<string, string> = {
  queued: '更新已排队', checking: '正在核对安装与发行版本', downloading: '正在下载并校验新版',
  stopping: '正在停止旧服务', backing_up: '正在备份评审数据', marketplace: '正在刷新固定版本的 marketplace',
  installing: '正在安装 Codex 插件', restarting: '正在启动新服务', verifying: '正在核实新服务版本',
  restoring: '正在恢复旧服务与数据', completed: '插件与服务已更新', failed: '更新失败，请检查恢复状态', canceled: '更新已取消',
}
const failures: Record<string, string> = {
  release_http_403: 'GitHub 暂时限制版本检查，请稍后重试。',
  release_http_429: 'GitHub 暂时限制版本检查，请稍后重试。',
  release_unreachable: '无法连接 GitHub，请检查网络后重试。',
  invalid_release: '无法核实官方版本，未执行更新。请稍后重试。',
}
const active = (value?: Update) => !!value && !['idle', 'completed', 'failed', 'canceled'].includes(value.phase)
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

export default function VersionSettings() {
  const { t } = useI18n()
  const [runtime, setRuntime] = useState<Runtime>()
  const [release, setRelease] = useState<Release>()
  const [update, setUpdate] = useState<Update>()
  const [checking, setChecking] = useState(false)
  const [working, setWorking] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState('')
  const [disconnected, setDisconnected] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const actual = await request<Runtime>('/api/runtime')
        if (disposed) return
        setRuntime(actual)
        const status = actual.local ? await request<Update>('/api/update/status') : undefined
        if (disposed) return
        if (status?.phase === 'completed' && actual.version !== status.version) {
          setUpdate({ ...status, phase: 'verifying' })
        } else setUpdate(status)
        setDisconnected(false)
      } catch { if (!disposed) setDisconnected(true) }
      if (!disposed) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  async function check() {
    setChecking(true); setError('')
    try { setRelease(await request<Release>('/api/releases/latest')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setChecking(false) }
  }
  async function mutate(action: 'start' | 'cancel') {
    if (!runtime?.csrfToken) return
    setWorking(true); setError('')
    try {
      const status = await request<Update>(`/api/update/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Logic-Margin-CSRF': runtime.csrfToken }, body: JSON.stringify(action === 'start' ? { version: release?.version } : {}) })
      if (action === 'start') { setUpdate(status); setCanceling(false) }
      else setCanceling(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setWorking(false) }
  }
  const busy = active(update)
  const newer = release?.newer && release.version !== runtime?.version
  const failure = error || update?.error
  return <section className="appearance-field version-settings" aria-labelledby="logic-margin-version-label">
    <h2 className="settings-section-title">{t('版本与更新')}</h2>
    <span className="appearance-field-label" id="logic-margin-version-label">LogicMargin <span className="runtime-version">{runtime?.version ?? t('版本读取中…')}</span></span>
    <p className="appearance-hint">{t('版本来自当前运行服务。')}</p>
    <button type="button" className="button" onClick={check} disabled={checking || busy || working}>{t(checking ? '正在检查新版…' : '检查新版')}</button>
    <div role="status" aria-live="polite" className="version-status">
      {release && !checking && <p className="appearance-hint">{newer ? <>{t('可更新至 {version}', { version: release.version })} · <a href={release.url} target="_blank" rel="noreferrer">{t('发行说明')}</a></> : t('已是最新稳定版')}</p>}
      {update && update.phase !== 'idle' && <p className="appearance-hint">{t(phases[update.phase] ?? '更新状态未知，请检查服务日志')}</p>}
      {canceling && busy && <p className="appearance-hint">{t('正在取消，必要时恢复旧服务…')}</p>}
      {disconnected && <p className="appearance-hint">{t('服务暂不可达，正在重连；更新结果尚未确认。')}</p>}
    </div>
    {newer && !busy && <button type="button" className="button primary" disabled={!runtime?.canUpdate || working || disconnected} onClick={() => void mutate('start')}>{t('一键更新本机插件与服务')}</button>}
    {busy && <button type="button" className="button" disabled={working || canceling || disconnected} onClick={() => void mutate('cancel')}>{t('取消更新')}</button>}
    <p className="appearance-hint">{runtime?.local === false ? t('远程页面只能检查新版。请在服务本机打开回环地址执行更新。') : t('一键更新仅支持本机已有的 Codex 插件安装，其他宿主尚未适配。')}</p>
    {(newer || busy || update?.reloadRequired) && <p className="appearance-hint">{t('更新会短暂中断服务；保留原评审与批注。完成后 MCP 可能需要重连。')}</p>}
    {failure && <p role="alert" className="appearance-hint version-error">{t(failures[failure] ?? '操作未完成，请核对错误后重试。')}{!failures[failure] && <> <code>{failure}</code></>}</p>}
  </section>
}
