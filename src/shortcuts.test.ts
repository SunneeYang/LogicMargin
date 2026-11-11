import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ariaShortcut, DEFAULT_SHORTCUTS, formatShortcut, normalizeShortcut, parseShortcutBindings, resolvedShortcut, SHORTCUT_ACTIONS, shortcutFromEvent, validateShortcut } from './shortcuts.ts'

const event = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra })

for (const apple of [false, true]) {
  test(`defaults are unique and configurable on ${apple ? 'Apple' : 'other'} platforms`, () => {
    assert.equal(SHORTCUT_ACTIONS.length, 27)
    assert.equal(new Set(SHORTCUT_ACTIONS.map(action => action.id)).size, 27)
    assert.equal(new Set(Object.values(DEFAULT_SHORTCUTS).map(binding => resolvedShortcut(binding, apple))).size, 27)
    for (const action of SHORTCUT_ACTIONS) assert.equal(validateShortcut(action.defaultBinding, DEFAULT_SHORTCUTS, action.id, apple), null, action.id)
  })
  test(`primary modifiers, shifts and physical punctuation resolve consistently (${apple})`, () => {
    const primary = apple ? { metaKey: true } : { ctrlKey: true }
    assert.equal(shortcutFromEvent(event(',', { code: 'Comma', ...primary }), apple), 'Mod+,')
    assert.equal(shortcutFromEvent(event('!', { code: 'Digit1', shiftKey: true }), apple), 'Shift+1')
    assert.equal(shortcutFromEvent(event('+', { code: 'Equal', shiftKey: true }), apple), 'Shift+=')
    assert.equal(shortcutFromEvent(event('F', { code: 'KeyF' }), apple), 'F')
    assert.equal(shortcutFromEvent(event('Enter', { ...primary, altKey: true }), apple), 'Mod+Alt+Enter')
    assert.equal(shortcutFromEvent(event('F8', { shiftKey: true }), apple), 'Shift+F8')
  })
  test(`conflicts account for platform modifier aliases (${apple})`, () => {
    assert.match(validateShortcut(`${apple ? 'Meta' : 'Ctrl'}+,`, DEFAULT_SHORTCUTS, 'toggleNavigation', apple)!, /使用/)
    assert.equal(validateShortcut('B', DEFAULT_SHORTCUTS, 'toggleNavigation', apple), null)
    assert.equal(validateShortcut('', DEFAULT_SHORTCUTS, 'toggleNavigation', apple), null)
    assert.equal(validateShortcut('Shift+S', DEFAULT_SHORTCUTS, 'settings', apple), null)
  })
  test(`browser and accessibility keys cannot be rebound (${apple})`, () => {
    for (const binding of ['Mod+L', 'Mod+Shift+T', 'Mod+W', 'Mod+R', 'Mod+F', 'Mod+1', 'Mod+=', 'Escape', 'Tab', 'Shift+Tab', 'F5', 'F11', 'F12', 'Backspace', 'Enter', 'Space']) {
      assert.match(validateShortcut(binding, DEFAULT_SHORTCUTS, 'settings', apple)!, /保留/, binding)
    }
  })
}

test('IME composition, AltGraph, repeat and modifier-only input are never recorded', () => {
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { getModifierState: (key: string) => key === 'AltGraph' }]) {
    assert.equal(shortcutFromEvent(event('f', extra)), null)
  }
  for (const key of ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Dead', 'Unidentified']) assert.equal(shortcutFromEvent(event(key)), null)
})

test('normalization rejects malformed and unsupported input without broad coercions', () => {
  assert.equal(normalizeShortcut('Shift+Mod+c'), 'Mod+Shift+C')
  assert.equal(normalizeShortcut(''), '')
  for (const value of ['Ctrl+Ctrl+K', 'Ctrl+', 'Ctrl++', 'Hyper+K', 'Ctrl+Two', ' K ', 'x'.repeat(100)]) assert.equal(normalizeShortcut(value), null, value)
})

test('letter bindings follow the active keyboard layout rather than QWERTY key positions', () => {
  assert.equal(shortcutFromEvent(event('a', { code: 'KeyQ' })), 'A')
  assert.equal(shortcutFromEvent(event('b', { code: 'KeyN' })), 'B')
  assert.equal(shortcutFromEvent(event('.', { code: 'KeyE' })), '.')
})

test('comment-save keys require a modifier and retain conflict checks', () => {
  assert.match(validateShortcut('K', DEFAULT_SHORTCUTS, 'saveComment')!, /需包含/)
  assert.match(validateShortcut('Shift+K', DEFAULT_SHORTCUTS, 'saveComment')!, /需包含/)
  assert.equal(validateShortcut('Mod+Alt+Enter', DEFAULT_SHORTCUTS, 'saveComment'), null)
  assert.match(validateShortcut('Mod+Shift+Enter', DEFAULT_SHORTCUTS, 'saveComment')!, /使用/)
})

test('invalid persisted values are bounded, unknown fields are ignored and conflicts never double-fire', () => {
  for (const value of [null, [], 'bad', 5]) assert.deepEqual(parseShortcutBindings(value), DEFAULT_SHORTCUTS)
  assert.deepEqual(parseShortcutBindings({ settings: 'Mod+L', saveComment: 'K', unknown: 'J' }), DEFAULT_SHORTCUTS)
  const duplicate = parseShortcutBindings({ settings: 'B', toggleNavigation: 'B' })
  const enabled = Object.values(duplicate).filter(Boolean)
  assert.equal(new Set(enabled.map(binding => resolvedShortcut(binding))).size, enabled.length)
  const changed = parseShortcutBindings({ ...DEFAULT_SHORTCUTS, settings: 'B', toggleNavigation: 'G', zoomOut: '' })
  assert.equal(changed.settings, 'B')
  assert.equal(changed.toggleNavigation, 'G')
  assert.equal(changed.zoomOut, '')
  assert.equal(DEFAULT_SHORTCUTS.settings, 'Mod+,')
})

test('visual labels and aria-keyshortcuts use the correct platform modifier', () => {
  assert.equal(formatShortcut('Mod+Shift+Enter', true), '⌘⇧Enter')
  assert.equal(formatShortcut('Mod+Alt+Enter', false), 'Ctrl+Alt+Enter')
  assert.equal(formatShortcut('Alt+ArrowDown', false), 'Alt+↓')
  assert.equal(ariaShortcut('Mod+,', true), 'Meta+,')
  assert.equal(ariaShortcut('Mod+Shift+Enter', false), 'Control+Shift+Enter')
  assert.equal(ariaShortcut('', true), '')
})
