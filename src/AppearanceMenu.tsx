import { useLayoutEffect, useState } from 'react'
import { Palette } from 'lucide-react'

const themes = {
  paper: { name: '纸页审阅', description: '暖白纸面、宋体标题与纸张投影' },
  soft: { name: '柔光浮雕', description: '雾蓝灰表面、柔和浮雕与凹陷输入' },
  glass: { name: '清透玻璃', description: '透光背景、透明面板与受光边缘' },
}
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

export default function AppearanceMenu() {
  const [appearance, setAppearance] = useState(readAppearance)
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
  return <details className="workspace-menu appearance-menu" data-keep-composer>
    <summary className="button" aria-label="外观设置"><Palette size={16} /><span>外观</span></summary>
    <div className="appearance-panel">
      <label htmlFor="interface-theme">界面主题</label>
      <select id="interface-theme" value={appearance.theme} onChange={event => change({ ...appearance, theme: event.target.value as Appearance['theme'] })}>
        {Object.entries(themes).map(([value, theme]) => <option key={value} value={value}>{theme.name}</option>)}
      </select>
      <p>{themes[appearance.theme].description}</p>
      <label htmlFor="appearance-mode">明暗模式</label>
      <select id="appearance-mode" value={appearance.mode} onChange={event => change({ ...appearance, mode: event.target.value as Appearance['mode'] })}>
        <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
      </select>
    </div>
  </details>
}
