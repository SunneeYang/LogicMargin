import { useSyncExternalStore } from 'react'
import { appMessages } from './i18n-app.ts'
import { graphMessages } from './i18n-graph.ts'
import { panelMessages } from './i18n-panels.ts'
import { errorMessages, validationFields } from './i18n-errors.ts'

export type Locale = 'zh-CN' | 'en'
export type Translator = (source: string, params?: Record<string, string | number>) => string
const storageKey = 'logic-margin:language'
export const englishMessages: Record<string, string> = {
  ...graphMessages, ...panelMessages, ...appMessages,
  '同步暂停': 'Sync paused',
  '正在同步': 'Syncing',
  '已保存到会话': 'Saved to session',
  '正在连接会话': 'Connecting to session',
  '外观设置': 'Appearance settings',
  '外观': 'Appearance',
  '界面主题': 'Theme',
  '纸页审阅': 'Paper',
  '柔光浮雕': 'Soft relief',
  '清透玻璃': 'Glass',
  '暖白纸面、宋体标题与纸张投影': 'Warm paper, serif headings, and soft shadows',
  '雾蓝灰表面、柔和浮雕与凹陷输入': 'Misty blue surfaces, soft relief, and inset fields',
  '透光背景、透明面板与受光边缘': 'Translucent surfaces and softly lit edges',
  '明暗模式': 'Color mode',
  '跟随系统': 'System',
  '浅色': 'Light',
  '深色': 'Dark',
  '界面语言': 'Interface language',
  '仅切换界面语言，评审内容与批注保留原文。': 'Changes interface text only. Review content and comments stay in their original language.',
  '连线 · {label}': 'Connection · {label}',
  '场景 · {title}': 'Scenario · {title}',
  '整个评审': 'Entire review',
  '已移除连线 · {id}': 'Removed connection · {id}',
  '已移除场景 · {id}': 'Removed scenario · {id}',
  '已移除评审 · {id}': 'Removed review · {id}',
}

export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'zh-CN' || saved === 'en') return saved
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
}

function readLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-CN'
  let saved: string | null = null
  try { saved = localStorage.getItem(storageKey) } catch { /* Language stays usable without browser storage. */ }
  return resolveLocale(saved, navigator.languages.length ? navigator.languages : [navigator.language])
}

export function translateForLocale(locale: Locale, source: string, params: Record<string, string | number> = {}): string {
  const message = locale === 'en' ? englishMessages[source] ?? source : source
  return message.replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(params, key) ? String(params[key]) : token)
}

let currentLocale = readLocale()
const listeners = new Set<() => void>()
const translators: Record<Locale, Translator> = {
  'zh-CN': (source, params) => translateForLocale('zh-CN', source, params),
  en: (source, params) => translateForLocale('en', source, params),
}
function applyDocumentLocale() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = currentLocale
  document.title = currentLocale === 'en' ? 'LogicMargin · Logic review' : 'LogicMargin · 逻辑旁批'
}
applyDocumentLocale()

export function setLocale(locale: Locale) {
  if (locale !== 'zh-CN' && locale !== 'en') return
  currentLocale = locale
  try { localStorage.setItem(storageKey, locale) } catch { /* Retain the choice for this tab if persistence is unavailable. */ }
  applyDocumentLocale()
  listeners.forEach(listener => listener())
}

export const translate: Translator = (source, params) => translators[currentLocale](source, params)

export function translateError(message: string, locale: Locale = currentLocale): string {
  if (locale !== 'en') return message
  const known = errorMessages[message] ?? englishMessages[message]
  if (known) return known
  const warnings = message.split(/\n(?=任务 .+ 无法读取，原文件已保留：)/)
  if (warnings.length > 1) return warnings.map(warning => translateError(warning, locale)).join('\n')
  const field = (name: string) => validationFields[name] ?? englishMessages[name] ?? name
  const validation: [RegExp, (...parts: string[]) => string][] = [
    [/^任务 (.+?) 无法读取，原文件已保留：(.+)$/s, (id, reason) => `Review ${id} could not be read; the original file has been preserved: ${translateError(reason, locale)}`],
    [/^会话文件损坏，原文件已保留：(.+)$/s, reason => `The session file is damaged and has been preserved: ${translateError(reason, locale)}`],
    [/^归档文件损坏，原文件已保留：(.+)$/s, reason => `The archive file is damaged and has been preserved: ${translateError(reason, locale)}`],
    [/^(.+)必须是(非空)?文本，最多 (\d+) 字符$/, (name, required, max) => `${field(name)} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`],
    [/^(.+)无效，最多 (\d+) 字符$/, (name, max) => `${field(name)} is invalid; the limit is ${max} characters.`],
    [/^(.+)必须是对象$/, name => `${field(name)} must be an object.`],
    [/^(.+)必须是数组$/, name => `${field(name)} must be an array.`],
    [/^(.+)必须是有效日期$/, name => `${field(name)} must be a valid date.`],
    [/^(.+)必须是正整数$/, name => `${field(name)} must be a positive integer.`],
    [/^(.+)的 ID 重复$/, name => `${field(name)} contains duplicate IDs.`],
    [/^(.+)无效$/, name => `${field(name)} is invalid.`],
    [/^会话服务返回 (\d+)$/, status => `The session service returned HTTP ${status}.`],
    [/^评审包读取失败（HTTP (\d+)）$/, status => `Could not load the review package (HTTP ${status})`],
    [/^回复 (.+) 的内容冲突；请先导出当前评审并处理冲突$/, id => `Reply ${id} has conflicting content. Export the current review before resolving the conflict.`],
    [/^批注 (.+) 的内容或目标冲突；请先导出当前评审并处理冲突$/, id => `Comment ${id} has conflicting content or targets. Export the current review before resolving the conflict.`],
    [/^评审记录 (.+) 的内容冲突$/, id => `Review record ${id} has conflicting content.`],
  ]
  for (const [pattern, format] of validation) {
    const match = pattern.exec(message)
    if (match) return format(...match.slice(1))
  }
  return message
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, () => currentLocale, () => 'zh-CN' as const)
  return { locale, t: translators[locale], setLocale }
}
