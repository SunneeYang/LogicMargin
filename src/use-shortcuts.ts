import { useEffect, useRef, useSyncExternalStore } from 'react'
import { CODE_SHORTCUTS, DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_STORAGE_KEY, normalizeShortcut, parseShortcutBindings, resolvedShortcut, shortcutFromEvent, validateShortcut } from './shortcuts.ts'
import type { ShortcutAction, ShortcutBindings } from './shortcuts.ts'

function readBindings(): ShortcutBindings {
  try { return parseShortcutBindings(JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_SHORTCUTS } }
}
let bindings = readBindings()
const listeners = new Set<() => void>()
function changed(next: ShortcutBindings, persist: boolean) {
  bindings = next
  if (persist) {
    try { localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(next)) }
    catch { /* Keep preferences usable in this page when browser storage is disabled. */ }
  }
  listeners.forEach(listener => listener())
}
function storage(event: StorageEvent) {
  if (event.key === SHORTCUT_STORAGE_KEY || event.key === null) changed(readBindings(), false)
}
function subscribe(listener: () => void) {
  if (!listeners.size && typeof window !== 'undefined') window.addEventListener('storage', storage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', storage)
  }
}
function setBinding(action: ShortcutAction, binding: string): string | null {
  const error = validateShortcut(binding, bindings, action)
  if (error) return error
  changed({ ...bindings, [action]: normalizeShortcut(binding)! }, true)
  return null
}
function resetBindings() { changed({ ...DEFAULT_SHORTCUTS }, true) }
export function useShortcutSettings() {
  const value = useSyncExternalStore(subscribe, () => bindings, () => DEFAULT_SHORTCUTS)
  return { bindings: value, setBinding, resetBindings }
}

export function useShortcuts(handlers: Partial<Record<ShortcutAction, () => boolean | void>>) {
  const { bindings } = useShortcutSettings()
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return
      const binding = shortcutFromEvent(event)
      if (!binding) return
      const action = SHORTCUT_ACTIONS.find(action => bindings[action.id] && resolvedShortcut(bindings[action.id]) === resolvedShortcut(binding))?.id
      const handler = action && latest.current[action]
      if (!action || !handler) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select')) return
      const editor = target?.closest('.cm-editor')
      if (editor ? !CODE_SHORTCUTS.has(action) || !!target?.closest('[contenteditable="true"]') : target?.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return
      if (handler() !== false) event.preventDefault()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [bindings])
}
