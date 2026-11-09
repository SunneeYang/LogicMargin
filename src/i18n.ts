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
  "版本读取中…": "Reading version…",
  "版本来自当前运行服务。": "Version reported by the running service.",
  "正在检查新版…": "Checking for updates…",
  "检查新版": "Check for updates",
  "可更新至 {version}": "Version {version} is available",
  "发行说明": "Release notes",
  "已是最新稳定版": "Up to date with the latest stable release",
  "更新已排队": "Update queued",
  "正在核对安装与发行版本": "Checking installation and release",
  "正在下载并校验新版": "Downloading and verifying release",
  "正在停止旧服务": "Stopping old service",
  "正在备份评审数据": "Backing up review data",
  "正在刷新固定版本的 marketplace": "Refreshing the pinned marketplace",
  "正在安装 Codex 插件": "Installing Codex plugin",
  "正在启动新服务": "Starting new service",
  "正在核实新服务版本": "Verifying running service version",
  "正在恢复旧服务与数据": "Restoring old service and data",
  "插件与服务已更新": "Plugin and service updated",
  "更新失败，请检查恢复状态": "Update failed; check recovery status",
  "更新已取消": "Update canceled",
  "更新状态未知，请检查服务日志": "Unknown update status; check service logs",
  "正在取消，必要时恢复旧服务…": "Canceling; restoring the old service if needed…",
  "服务暂不可达，正在重连；更新结果尚未确认。": "Service unreachable; reconnecting. Update result is not yet confirmed.",
  "一键更新本机插件与服务": "Update local plugin and service",
  "取消更新": "Cancel update",
  "远程页面只能检查新版。请在服务本机打开回环地址执行更新。": "Remote pages can check releases. Open the loopback URL on the service machine to install.",
  "一键更新仅支持本机已有的 Codex 插件安装，其他宿主尚未适配。": "One-click updates support an existing local Codex plugin installation. Other hosts are not supported yet.",
  "更新会短暂中断服务；保留原评审与批注。完成后 MCP 可能需要重连。": "Updating briefly interrupts the service and preserves reviews and comments. MCP may need reconnection afterward.",
  "操作未完成，请核对错误后重试。": "Operation incomplete. Check the error before retrying.",
  'GitHub 暂时限制版本检查，请稍后重试。': 'GitHub is temporarily limiting release checks. Try again later.',
  '无法连接 GitHub，请检查网络后重试。': 'Unable to reach GitHub. Check your connection and try again.',
  '无法核实官方版本，未执行更新。请稍后重试。': 'The official release could not be verified. No update was performed. Try again later.',
  '外观设置': 'Appearance settings',
  '设置': 'Settings',
  '界面': 'Interface',
  '版本与更新': 'Version and updates',
  '选择步骤后，可在这里继续查看讨论、详情和代码。': 'Select a step to continue reading its discussion, details, and code here.',
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
