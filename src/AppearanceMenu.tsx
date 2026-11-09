import { useLayoutEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import { useI18n } from './i18n.ts'
import VersionSettings from './VersionSettings.tsx'

const themes = {
  paper: { name: '纸页审阅', description: '暖白纸面、宋体标题与纸张投影' },
  soft: { name: '柔光浮雕', description: '雾蓝灰表面、柔和浮雕与凹陷输入' },
  glass: { name: '清透玻璃', description: '透光背景、透明面板与受光边缘' },
}
const modes = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const
const languages = [['zh-CN', '简体中文'], ['en', 'English']] as const
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

export default function AppearanceMenu({ codeSplit, onCodeSplitChange }: { codeSplit: boolean; onCodeSplitChange: (split: boolean) => void }) {
  const { t, locale, setLocale } = useI18n()
  const [appearance, setAppearance] = useState(readAppearance)
  const [menuOpen, setMenuOpen] = useState(false)
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
  return <details className="workspace-menu appearance-menu" data-keep-composer onToggle={event => setMenuOpen(event.currentTarget.open)}>
    <summary className="button" aria-label={t('设置')}><Settings size={16} /><span>{t('设置')}</span></summary>
    <div className="appearance-panel">
      <h2 className="settings-section-title">{t('界面')}</h2>
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
      {menuOpen && <VersionSettings />}
    </div>
  </details>
}
