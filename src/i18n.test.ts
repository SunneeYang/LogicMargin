import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureEdgeLabel } from './graph-label.ts'
import { englishMessages, resolveLocale, translateError, translateForLocale } from './i18n.ts'
import { SHORTCUT_ACTIONS } from './shortcuts.ts'

test('explicit language wins; otherwise use the first supported browser preference', () => {
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN')
  assert.equal(resolveLocale('en', ['zh-TW']), 'en')
  assert.equal(resolveLocale(null, ['fr-FR', 'zh-TW', 'en-US']), 'zh-CN')
  assert.equal(resolveLocale('invalid', ['en-GB', 'zh-CN']), 'en')
  assert.equal(resolveLocale(null, ['fr-FR']), 'en')
  assert.equal(resolveLocale(null, []), 'en')
})

test('translations interpolate values literally and preserve unknown text', () => {
  assert.equal(translateForLocale('en', '外观'), 'Appearance')
  assert.equal(translateForLocale('zh-CN', '外观'), '外观')
  assert.equal(translateForLocale('en', 'custom {value}', { value: '$& <tag> {other}' }), 'custom $& <tag> {other}')
  assert.equal(translateForLocale('en', 'business rule: {missing}'), 'business rule: {missing}')
})

test('English messages retain every named interpolation value', () => {
  const parameters = (message: string) => [...new Set(message.match(/\{\w+\}/g))].sort()
  for (const [source, translation] of Object.entries(englishMessages)) {
    assert.ok(translation.trim(), `Empty translation: ${source}`)
    assert.deepEqual(parameters(translation), parameters(source), `Parameters differ: ${source}`)
  }
})

test('every configurable shortcut has an English label and group', () => {
  for (const action of SHORTCUT_ACTIONS) for (const key of [action.label, action.group]) {
    assert.ok(englishMessages[key], `Missing shortcut translation: ${key}`)
    assert.doesNotMatch(translateForLocale('en', key), /\p{Script=Han}/u)
  }
})

test('validation and service errors are translated at the display boundary without changing identifiers', () => {
  assert.equal(translateError('评审文件必须是对象', 'en'), 'Review document must be an object.')
  assert.equal(translateError('评审标题必须是非空文本，最多 2000 字符', 'en'), 'Review title must be nonempty text of at most 2000 characters.')
  assert.match(translateError('批注 原始-id 的内容或目标冲突；请先导出当前评审并处理冲突', 'en'), /Comment 原始-id has conflicting/)
  assert.equal(translateError('评审文件必须是对象', 'zh-CN'), '评审文件必须是对象')
  assert.equal(translateError('custom server error: 原文', 'en'), 'custom server error: 原文')
})


test('task-list warnings translate each failure without changing task identifiers', () => {
  const message = '任务 原始-id 无法读取，原文件已保留：会话文件损坏，原文件已保留：评审文件必须是对象\n任务 next-id 无法读取，原文件已保留：会话服务返回 404'
  assert.equal(translateError(message, 'en'), 'Review 原始-id could not be read; the original file has been preserved: The session file is damaged and has been preserved: Review document must be an object.\nReview next-id could not be read; the original file has been preserved: The session service returned HTTP 404.')
})

test('translated connection changes with comments fit the reserved status row', () => {
  for (const locale of ['zh-CN', 'en'] as const) for (const change of ['新增', '已修改', '已移除']) {
    const label = translateForLocale(locale, '{change} · 有批注', { change: translateForLocale(locale, change) })
    const measured = measureEdgeLabel(label)
    assert.ok(measured.width <= 120, label)
    assert.equal(measured.lines.length, 1)
  }
})
