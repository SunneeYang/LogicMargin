import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, PanelRight, Plus, X } from 'lucide-react'
import type { CommentDraft } from './types.ts'

export default function CommentComposer({ draft, discussion, docked, position, onChange, onSave, onClose, onToggle, onInteract }: {
  draft: CommentDraft | null
  discussion?: { key: string; title: string; context: string; content: ReactNode; replyLabel?: string; canReply: boolean; onReply: () => void; onCollapse: () => void }
  docked: boolean
  position: { left: number; top: number }
  onChange: (body: string) => void
  onSave: () => string | null
  onClose: () => void
  onToggle: () => void
  onInteract: () => void
}) {
  const container = useRef<HTMLElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const selection = useRef<{ start: number; end: number } | null>(null)
  const [error, setError] = useState('')
  const open = !!(draft || discussion)
  const [present, setPresent] = useState(open)
  const last = useRef({ draft, discussion, docked })
  if (open) last.current = { draft, discussion, docked }
  const shown = open ? { draft, discussion, docked } : last.current
  const surfaceDocked = shown.docked && !shown.discussion
  const animation = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const style = getComputedStyle(element)
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const near = { opacity: 0, transform: reduce ? 'none' : `translateY(${style.getPropertyValue('--thread-shift')}px) scale(${style.getPropertyValue('--thread-scale')})` }
    const rest = { opacity: 1, transform: 'none' }
    const from = present ? { opacity: style.opacity, transform: style.transform } : near
    animation.current?.cancel()
    setPresent(true)
    const current = element.animate([from, open ? rest : near], {
      duration: reduce ? 140 : Number(style.getPropertyValue(open ? '--thread-enter-ms' : '--thread-exit-ms')),
      easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both',
    })
    animation.current = current
    void current.finished.then(() => { if (!open) setPresent(false); current.cancel() }).catch(() => {})
  }, [open, surfaceDocked, discussion?.key])
  useEffect(() => () => animation.current?.cancel(), [])
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const finish = () => { if (reduced.matches && animation.current?.playState === 'running') animation.current.finish() }
    reduced.addEventListener('change', finish)
    return () => reduced.removeEventListener('change', finish)
  }, [])
  useEffect(() => {
    if (!open) return
    setError('')
    if (draft) {
      if (discussion || matchMedia('(min-width: 901px) and (pointer: fine)').matches) {
        input.current?.focus({ preventScroll: true })
        if (discussion) input.current?.scrollIntoView({ block: 'nearest' })
      } else container.current?.scrollIntoView({ block: 'nearest' })
    } else if (discussion) container.current?.focus({ preventScroll: true })
  }, [draft?.key, discussion?.key])
  useLayoutEffect(() => {
    if (selection.current && input.current) {
      input.current.focus({ preventScroll: true })
      input.current.setSelectionRange(selection.current.start, selection.current.end)
      selection.current = null
    }
  }, [docked])
  if (!open && !present) return null
  draft = shown.draft
  discussion = shown.discussion
  function save() { setError(onSave() ?? '') }
  const surface = <section ref={container} className={`comment-composer ${surfaceDocked ? 'is-docked' : 'is-inline'}${discussion ? ' has-discussion' : ''}`} style={surfaceDocked ? undefined : position}
    role="dialog" aria-modal="false" aria-labelledby="composer-title" tabIndex={discussion ? -1 : undefined} data-composer data-composing={!!draft} data-state={open ? 'open' : 'closing'} inert={!open} aria-hidden={!open || undefined}
    onPointerEnter={onInteract} onPointerDownCapture={onInteract} onFocusCapture={onInteract} onWheelCapture={onInteract} onScrollCapture={onInteract}>
    <header className="composer-header"><h3 id="composer-title"><MessageSquare size={16} />{discussion ? '节点讨论' : draft?.replyTo ? '回复讨论' : draft?.basis === 'baseline' ? '基线 B 批注' : '流程批注'}</h3>
      <div className="tool-group">{!discussion && <button className="button icon-button" type="button" aria-label={docked ? '返回图内编辑' : '移到侧栏编辑'} onPointerDown={event => event.preventDefault()} onClick={() => {
        if (input.current && document.activeElement === input.current) selection.current = { start: input.current.selectionStart, end: input.current.selectionEnd }
        onToggle()
      }}><PanelRight size={16} /></button>}<button className="button icon-button" type="button" aria-label={discussion ? '关闭讨论' : '关闭编辑器并保留草稿'} onClick={onClose}><X size={16} /></button></div>
    </header>
    {discussion && <div className="discussion-heading"><p className="discussion-target">{discussion.title}</p><p className="discussion-context">{discussion.context}</p></div>}
    {!discussion && draft && <p className="composer-targets">{draft.targets.length > 1 && <strong>所选 {draft.targets.length} 项 · </strong>}{draft.labels.join(' · ')}</p>}
    {discussion && <div className="discussion-threads">{discussion.content}</div>}
    <div className="composer-footer">
    {draft && <form onSubmit={event => { event.preventDefault(); save() }}>
      {discussion?.replyLabel && <p className="discussion-reply-label">{discussion.replyLabel}</p>}
      <label htmlFor="comment-body">{draft.replyTo ? '补充说明' : '问题与预期行为'}</label>
      <textarea ref={input} id="comment-body" rows={4} maxLength={10000} value={draft.body} aria-invalid={!!error} aria-describedby={error ? 'composer-error' : 'composer-hint'}
        placeholder={draft.replyTo ? '补充问题、处理结果或复核依据…' : '哪里不符合预期？希望怎样处理？'}
        onChange={event => { setError(''); onChange(event.target.value) }}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); save() } }} />
      {error && <p className="composer-error" id="composer-error" role="alert">{error}</p>}
      <p className="composer-hint" id="composer-hint">草稿自动保留 · ⌘ / Ctrl + Enter 保存</p>
      <div className="composer-actions">{discussion && <button className="button collapse-reply" type="button" aria-expanded="true" onClick={discussion.onCollapse}>收起回复</button>}<button className="button primary" type="submit" disabled={!draft.body.trim()}><Plus size={14} />{draft.replyTo ? '保存回复' : '添加批注'}</button></div>
    </form>}
    {discussion && !draft && <button className="button discussion-reply-toggle" type="button" aria-label="回复当前意见" aria-expanded="false" disabled={!discussion.canReply} onClick={discussion.onReply}>回复</button>}
    </div>
  </section>
  return discussion ? createPortal(surface, document.body) : surface
}
