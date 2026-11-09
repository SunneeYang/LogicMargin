import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings, X } from 'lucide-react'
import { useI18n } from './i18n.ts'
import ShortcutSettings from './ShortcutSettings.tsx'
import VersionSettings from './VersionSettings.tsx'
import { ariaShortcut, formatShortcut } from './shortcuts.ts'
import { useShortcutSettings } from './use-shortcuts.ts'
import './settings-dialog.css'

const themes = {
  paper: { name: '纸页审阅', description: '暖白纸面、宋体标题与纸张投影' },
  soft: { name: '柔光浮雕', description: '雾蓝灰表面、柔和浮雕与凹陷输入' },
  glass: { name: '清透玻璃', description: '透光背景、透明面板与受光边缘' },
}
const modes = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const
const languages = [['zh-CN', '简体中文'], ['en', 'English']] as const
const tabs = [['interface', '界面'], ['shortcuts', '快捷键'], ['version', '版本与更新']] as const
type SettingsTab = typeof tabs[number][0]
type Appearance = { theme: keyof typeof themes; mode: 'system' | 'light' | 'dark' }
const key = 'logic-margin:appearance'

function readAppearance(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    return {
      theme: value?.theme === 'soft' || value?.theme === 'glass' ? value.theme : 'paper',
      mode: value?.mode === 'light' || value?.mode === 'dark' ? value.mode : 'system',
    }
  } catch { return { theme: 'paper', mode: 'system' } }
}

function applyAppearance(value: Appearance) {
  document.documentElement.dataset.theme = value.theme
  document.documentElement.dataset.mode = value.mode === 'system'
    ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : value.mode
}

// Apply saved preferences before React paints, including portals and loading states.
applyAppearance(readAppearance())

export default function AppearanceMenu({ codeSplit, onCodeSplitChange, open, onOpenChange }: {
  codeSplit: boolean
  onCodeSplitChange: (split: boolean) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, locale, setLocale } = useI18n()
  const { bindings } = useShortcutSettings()
  const [appearance, setAppearance] = useState(readAppearance)
  const [tab, setTab] = useState<SettingsTab>('interface')
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const backdropPointer = useRef(false)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!open) {
      if (dialog.open) dialog.close()
      return
    }
    if (!dialog.open) dialog.showModal()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])
  useLayoutEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)')
    const update = () => applyAppearance(appearance)
    update()
    system.addEventListener('change', update)
    return () => system.removeEventListener('change', update)
  }, [appearance])
  function change(next: Appearance) {
    setAppearance(next)
    try { localStorage.setItem(key, JSON.stringify(next)) }
    catch { /* Appearance stays usable when private browsing disables storage. */ }
  }
  return <div className="workspace-menu appearance-menu" data-keep-composer>
    <button ref={triggerRef} type="button" className="button settings-trigger" aria-label={t('设置')} title={bindings.settings ? `${t('设置')} · ${formatShortcut(bindings.settings)}` : t('设置')} aria-keyshortcuts={ariaShortcut(bindings.settings) || undefined} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-dialog`} onClick={() => onOpenChange(true)}><Settings size={16} /><span>{t('设置')}</span></button>
    {createPortal(<dialog ref={dialogRef} id={`${id}-dialog`} className="settings-dialog" aria-labelledby={`${id}-title`} aria-modal="true" data-keep-composer
      onKeyDown={event => {
        if (event.key !== 'Tab' || event.defaultPrevented) return
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')].filter(item => item.tabIndex >= 0 && item.checkVisibility())
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          const next = event.shiftKey ? last : first
          next?.focus()
        }
      }}
      onCancel={event => { event.preventDefault(); onOpenChange(false) }}
      onClose={event => {
        if (event.currentTarget.open) return
        if (open) onOpenChange(false)
        triggerRef.current?.focus({ preventScroll: true })
      }}
      onPointerDown={event => { backdropPointer.current = event.target === event.currentTarget }}
      onPointerCancel={() => { backdropPointer.current = false }}
      onClick={event => {
        const startedOnBackdrop = backdropPointer.current
        backdropPointer.current = false
        if (!startedOnBackdrop || event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onOpenChange(false)
      }}>
      {open && <div className="appearance-panel">
        <header className="settings-header">
          <h2 id={`${id}-title`}>{t('设置')}</h2>
          <button type="button" className="button subtle icon-button settings-close" aria-label={t('关闭设置')} onClick={() => onOpenChange(false)} autoFocus><X size={18} /></button>
        </header>
        <div className="settings-tabs" role="tablist" aria-label={t('设置分类')}>
          {tabs.map(([value, label], index) => <button key={value} ref={element => { tabRefs.current[index] = element }} type="button" role="tab" id={`${id}-${value}-tab`} aria-selected={tab === value} aria-controls={`${id}-${value}-panel`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}
            onKeyDown={event => {
              let next = index
              if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
              else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = tabs.length - 1
              else return
              event.preventDefault()
              setTab(tabs[next][0])
              tabRefs.current[next]?.focus()
            }}>{t(label)}</button>)}
        </div>
        <div className="settings-content">
          <div className="settings-tabpanel settings-interface" id={`${id}-interface-panel`} role="tabpanel" aria-labelledby={`${id}-interface-tab`} hidden={tab !== 'interface'} tabIndex={0}>
            <div className="appearance-field">
              <label className="appearance-field-label" htmlFor="interface-theme">{t('界面主题')}</label>
              <select id="interface-theme" aria-describedby="interface-theme-help" value={appearance.theme} onChange={event => change({ ...appearance, theme: event.target.value as Appearance['theme'] })}>
                {Object.entries(themes).map(([value, theme]) => <option key={value} value={value}>{t(theme.name)}</option>)}
              </select>
              <p className="appearance-hint" id="interface-theme-help">{t(themes[appearance.theme].description)}</p>
            </div>
            <div className="appearance-field">
              <span className="appearance-field-label" id="appearance-mode-label">{t('明暗模式')}</span>
              <div className="appearance-options" id="appearance-mode" role="group" aria-labelledby="appearance-mode-label">
                {modes.map(([value, label]) => <button key={value} type="button" className="button" value={value} aria-pressed={appearance.mode === value} onClick={() => change({ ...appearance, mode: value })}>{t(label)}</button>)}
              </div>
            </div>
            <div className="appearance-field">
              <span className="appearance-field-label" id="interface-language-label">{t('界面语言')}</span>
              <div className="appearance-options" id="interface-language" role="group" aria-labelledby="interface-language-label" aria-describedby="interface-language-help">
                {languages.map(([value, label]) => <button key={value} type="button" className="button" value={value} aria-pressed={locale === value} onClick={() => setLocale(value)}>{label}</button>)}
              </div>
              <p className="appearance-hint" id="interface-language-help">{t('仅切换界面语言，评审内容与批注保留原文。')}</p>
            </div>
            <div className="appearance-field">
              <label className="appearance-field-label" htmlFor="code-layout">{t('代码对照布局')}</label>
              <select id="code-layout" value={codeSplit ? 'split' : 'unified'} onChange={event => onCodeSplitChange(event.target.value === 'split')}>
                <option value="split">{t('并排')}</option>
                <option value="unified">{t('统一')}</option>
              </select>
            </div>
          </div>
          <div className="settings-tabpanel" id={`${id}-shortcuts-panel`} role="tabpanel" aria-labelledby={`${id}-shortcuts-tab`} hidden={tab !== 'shortcuts'} tabIndex={0}><ShortcutSettings /></div>
          <div className="settings-tabpanel" id={`${id}-version-panel`} role="tabpanel" aria-labelledby={`${id}-version-tab`} hidden={tab !== 'version'} tabIndex={0}><VersionSettings /></div>
        </div>
      </div>}
    </dialog>, document.body)}
  </div>
}
