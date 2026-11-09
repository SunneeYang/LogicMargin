import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useI18n } from './i18n.ts'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, formatShortcut, shortcutFromEvent } from './shortcuts.ts'
import type { ShortcutAction } from './shortcuts.ts'
import { useShortcutSettings } from './use-shortcuts.ts'

export default function ShortcutSettings() {
  const { t } = useI18n()
  const { bindings, setBinding, resetBindings } = useShortcutSettings()
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null)
  const [notice, setNotice] = useState('')
  const id = useId()
  const groups = [...new Set(SHORTCUT_ACTIONS.map(action => action.group))]

  function save(action: ShortcutAction, binding: string, message: string) {
    const failure = setBinding(action, binding)
    setError(failure ? { action, message: failure } : null)
    if (failure) { setNotice(''); return }
    setRecording(null)
    setNotice(message)
  }

  function record(event: KeyboardEvent<HTMLButtonElement>, action: ShortcutAction) {
    if (recording !== action) return
    event.stopPropagation()
    if (event.key === 'Tab') { setRecording(null); return }
    event.preventDefault()
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return
    if (event.key === 'Escape') { setRecording(null); setError(null); setNotice('已取消录制'); return }
    if (event.key === 'Backspace' || event.key === 'Delete') { save(action, '', '快捷键已停用'); return }
    const binding = shortcutFromEvent(event.nativeEvent)
    if (binding) save(action, binding, '快捷键已保存')
  }

  return <div className="shortcut-settings">
    <div className="shortcuts-intro">
      <p className="appearance-hint" id={`${id}-help`}>{t('点击键位后按下新的组合键。Escape 取消，Tab 离开，Backspace 或 Delete 停用。')}</p>
      <button type="button" className="button shortcuts-reset-all" onClick={() => { resetBindings(); setRecording(null); setError(null); setNotice('已恢复全部默认快捷键') }}>{t('全部恢复默认')}</button>
    </div>
    <p className="shortcuts-notice appearance-hint" role="status" aria-live="polite">{notice && t(notice)}</p>
    {groups.map((group, index) => <section className="shortcut-group" key={group} aria-labelledby={`${id}-group-${index}`}>
      <h3 id={`${id}-group-${index}`}>{t(group)}</h3>
      <div className="shortcut-rows">
        {SHORTCUT_ACTIONS.filter(action => action.group === group).map(action => {
          const active = recording === action.id
          const failure = error?.action === action.id ? error.message : null
          return <div className="shortcut-row" key={action.id} data-shortcut-action={action.id}>
            <span className="shortcut-label" id={`${id}-${action.id}-label`}>{t(action.label)}</span>
            <div className="shortcut-controls" role="group" aria-labelledby={`${id}-${action.id}-label`}>
              <button type="button" className="button shortcut-binding" aria-pressed={active} aria-label={t(active ? '正在录制「{action}」快捷键' : '修改「{action}」快捷键', { action: t(action.label) })} aria-describedby={failure ? `${id}-${action.id}-error` : `${id}-help`} aria-invalid={!!failure}
                onClick={() => { setRecording(active ? null : action.id); setError(null); setNotice('') }}
                onKeyDownCapture={event => record(event, action.id)} onBlur={() => { if (active) setRecording(null) }}>
                {active ? t('请按快捷键…') : bindings[action.id] ? formatShortcut(bindings[action.id]) : t('已停用')}
              </button>
              <button type="button" className="button subtle shortcut-clear" disabled={!bindings[action.id]} aria-label={t('停用「{action}」快捷键', { action: t(action.label) })} onClick={() => save(action.id, '', '快捷键已停用')}>{t('停用')}</button>
              <button type="button" className="button subtle shortcut-reset" disabled={bindings[action.id] === DEFAULT_SHORTCUTS[action.id]} aria-label={t('恢复「{action}」默认快捷键', { action: t(action.label) })} onClick={() => save(action.id, DEFAULT_SHORTCUTS[action.id], '已恢复默认快捷键')}>{t('恢复默认')}</button>
            </div>
            {failure && <p className="shortcut-error" id={`${id}-${action.id}-error`} role="alert">{t(failure)}</p>}
          </div>
        })}
      </div>
    </section>)}
  </div>
}
