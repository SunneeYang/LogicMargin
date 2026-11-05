import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureEdgeLabel } from './graph-label.ts'

test('long conditions wrap without losing Chinese, ASCII, whitespace or Unicode characters', () => {
  const condition = '旧 attempt / TargetIndex 不匹配，或来源读取失败时，保留原状态并退出 🧩'
  const result = measureEdgeLabel(condition)
  assert.ok(result.lines.length > 1)
  assert.equal(result.lines.join(''), condition)
  assert.ok(result.width <= 192)
  assert.equal(result.height, result.lines.length * 16 + 8)
  assert.ok(result.lines.every(line => !/[\uD800-\uDBFF]$/.test(line)))
})

test('explicit condition line breaks and empty labels have finite complete bounds', () => {
  assert.deepEqual(measureEdgeLabel('读取成功\n进入下一步').lines, ['读取成功', '进入下一步'])
  assert.deepEqual(measureEdgeLabel(''), { lines: [''], width: 12, height: 24 })
})
