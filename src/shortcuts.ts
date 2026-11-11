export const SHORTCUT_ACTIONS = [
  { id: 'settings', label: '打开设置', group: '工作区', defaultBinding: 'Mod+,' },
  { id: 'toggleNavigation', label: '展开或收起场景导航', group: '工作区', defaultBinding: 'B' },
  { id: 'toggleInspector', label: '展开或收起评审面板', group: '工作区', defaultBinding: 'Shift+B' },
  { id: 'previousScene', label: '上一个场景', group: '工作区', defaultBinding: 'Alt+ArrowUp' },
  { id: 'nextScene', label: '下一个场景', group: '工作区', defaultBinding: 'Alt+ArrowDown' },
  { id: 'taskManager', label: '打开评审任务', group: '工作区', defaultBinding: 'T' },
  { id: 'panMode', label: '浏览模式', group: '画布', defaultBinding: 'H' },
  { id: 'selectMode', label: '框选模式', group: '画布', defaultBinding: 'V' },
  { id: 'fitGraph', label: '显示完整流程', group: '画布', defaultBinding: 'Shift+1' },
  { id: 'readingView', label: '恢复阅读视图', group: '画布', defaultBinding: 'Shift+2' },
  { id: 'zoomIn', label: '放大流程', group: '画布', defaultBinding: 'Shift+=' },
  { id: 'zoomOut', label: '缩小流程', group: '画布', defaultBinding: '-' },
  { id: 'focusCanvas', label: '专注画布', group: '画布', defaultBinding: 'F' },
  { id: 'locateSelection', label: '定位当前选择', group: '画布', defaultBinding: 'L' },
  { id: 'addComment', label: '添加批注', group: '审查', defaultBinding: 'N' },
  { id: 'showDiscussion', label: '查看讨论', group: '审查', defaultBinding: 'D' },
  { id: 'showDetails', label: '查看详情', group: '审查', defaultBinding: 'I' },
  { id: 'showCode', label: '查看代码 diff', group: '审查', defaultBinding: 'C' },
  { id: 'startReview', label: '定位首条意见并打开讨论', group: '审查', defaultBinding: 'Shift+R' },
  { id: 'previousReviewItem', label: '上一条评审意见', group: '审查', defaultBinding: '[' },
  { id: 'nextReviewItem', label: '下一条评审意见', group: '审查', defaultBinding: ']' },
  { id: 'saveComment', label: '保存批注或回复', group: '审查', defaultBinding: 'Mod+Enter' },
  { id: 'reviewRound', label: '进入本轮审查', group: '审查', defaultBinding: 'Mod+Shift+Enter' },
  { id: 'toggleCodeLayout', label: '切换代码对照布局', group: '代码对照', defaultBinding: 'U' },
  { id: 'nextDifference', label: '下一处差异', group: '代码对照', defaultBinding: 'F8' },
  { id: 'previousDifference', label: '上一处差异', group: '代码对照', defaultBinding: 'Shift+F8' },
  { id: 'toggleFullCode', label: '展开全文或折叠未变', group: '代码对照', defaultBinding: 'E' },
] as const
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]['id']
export type ShortcutBindings = Record<ShortcutAction, string>
export const DEFAULT_SHORTCUTS: Readonly<ShortcutBindings> = Object.freeze(Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, action.defaultBinding])) as ShortcutBindings)
export const CODE_SHORTCUTS = new Set<ShortcutAction>(['nextDifference', 'previousDifference', 'toggleFullCode', 'toggleCodeLayout'])
export const SHORTCUT_STORAGE_KEY = 'logic-margin:shortcuts'
const modifiers = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const
const namedKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete'])
const shiftedKeys: Record<string, string> = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' }
const codeKeys: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' }
export const isApplePlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function normalizeShortcut(binding: string): string | null {
  if (binding === '') return ''
  if (typeof binding !== 'string' || binding.length > 80) return null
  const parts = binding.split('+')
  let key = parts.pop()!
  if (/^[a-z]$/i.test(key)) key = key.toUpperCase()
  if (!/^[A-Z0-9\[\]\\;'/.,=`-]$/.test(key) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(key) && !namedKeys.has(key)) return null
  if (parts.some(part => !modifiers.some(modifier => modifier === part)) || new Set(parts).size !== parts.length) return null
  return [...modifiers.filter(modifier => parts.includes(modifier)), key].join('+')
}

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & Partial<Pick<KeyboardEvent, 'code' | 'isComposing' | 'keyCode' | 'repeat' | 'getModifierState'>>
export function shortcutFromEvent(event: ShortcutEvent, apple = isApplePlatform()): string | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.getModifierState?.('AltGraph')) return null
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph'].includes(event.key)) return null
  let key = event.key === ' ' ? 'Space' : event.key
  if (/^[a-z]$/i.test(key)) key = key.toUpperCase()
  else if (event.shiftKey && event.code && /^Digit[0-9]$/.test(event.code)) key = event.code.slice(5)
  else if (event.shiftKey && event.code && codeKeys[event.code]) key = codeKeys[event.code]
  else if (event.shiftKey && shiftedKeys[key]) key = shiftedKeys[key]
  const parts: string[] = []
  if (apple ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (apple && event.ctrlKey) parts.push('Ctrl')
  if (!apple && event.metaKey) parts.push('Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return normalizeShortcut([...parts, key].join('+'))
}

export function resolvedShortcut(binding: string, apple = isApplePlatform()): string {
  const normalized = normalizeShortcut(binding)
  if (!normalized) return ''
  const parts = normalized.split('+'), key = parts.pop()!
  const resolved = new Set(parts.map(part => part === 'Mod' ? apple ? 'Meta' : 'Ctrl' : part))
  return [...['Ctrl', 'Meta', 'Alt', 'Shift'].filter(part => resolved.has(part)), key].join('+')
}

function bindingError(binding: string, apple: boolean): string | null {
  const normalized = normalizeShortcut(binding)
  if (normalized === null) return '请选择有效的单个快捷键组合。'
  if (!normalized) return null
  const parts = resolvedShortcut(normalized, apple).split('+'), key = parts.pop()!
  const primary = parts.includes('Ctrl') || parts.includes('Meta')
  if (['Tab', 'Escape', 'Backspace', 'Delete', 'F1', 'F3', 'F5', 'F6', 'F10', 'F11', 'F12'].includes(key)
    || !parts.length && ['Enter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)
    || primary && (/^[0-9]$/.test(key) || ['L', 'T', 'W', 'N', 'R', 'Q', 'F', 'P', 'O', 'S', 'A', 'C', 'V', 'X', 'Z', 'Y', '=', '-'].includes(key))) return '此快捷键由浏览器或系统保留。'
  return null
}

export function validateShortcut(binding: string, bindings: Readonly<ShortcutBindings>, exceptAction?: ShortcutAction, apple = isApplePlatform()): string | null {
  const error = bindingError(binding, apple)
  if (error || !binding) return error
  if (exceptAction === 'saveComment' && !/(?:^|\+)(?:Mod|Ctrl|Meta|Alt)\+/.test(normalizeShortcut(binding)!)) return '保存快捷键需包含 Ctrl、Command 或 Alt。'
  const resolved = resolvedShortcut(binding, apple)
  return SHORTCUT_ACTIONS.some(action => action.id !== exceptAction && resolvedShortcut(bindings[action.id], apple) === resolved) ? '此快捷键已被其他操作使用。' : null
}

export function parseShortcutBindings(value: unknown, apple = isApplePlatform()): ShortcutBindings {
  const result: ShortcutBindings = { ...DEFAULT_SHORTCUTS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const action of SHORTCUT_ACTIONS) {
    const binding = (value as Record<string, unknown>)[action.id]
    if (typeof binding !== 'string' || bindingError(binding, apple)) continue
    const normalized = normalizeShortcut(binding)!
    if (action.id === 'saveComment' && normalized && !/(?:^|\+)(?:Mod|Ctrl|Meta|Alt)\+/.test(normalized)) continue
    result[action.id] = normalized
  }
  const seen = new Set<string>()
  for (const action of SHORTCUT_ACTIONS) {
    const key = resolvedShortcut(result[action.id], apple)
    if (key && seen.has(key)) result[action.id] = ''
    else if (key) seen.add(key)
  }
  return result
}

export function formatShortcut(binding: string, apple = isApplePlatform()): string {
  const normalized = normalizeShortcut(binding)
  if (!normalized) return ''
  const symbols: Record<string, string> = { Mod: apple ? '⌘' : 'Ctrl', Ctrl: apple ? '⌃' : 'Ctrl', Meta: apple ? '⌘' : 'Meta', Alt: apple ? '⌥' : 'Alt', Shift: apple ? '⇧' : 'Shift', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }
  return normalized.split('+').map(part => symbols[part] ?? part).join(apple ? '' : '+')
}

export function ariaShortcut(binding: string, apple = isApplePlatform()): string {
  return resolvedShortcut(binding, apple).replace(/^Ctrl(?=\+)|(?<=\+)Ctrl(?=\+)/g, 'Control')
}
