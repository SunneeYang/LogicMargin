import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overviewBands } from './code-overview.ts'

test('a dense single-column cluster preserves both colors regardless of paint order', () => {
  const bands = overviewBands([
    { top: 50, bottom: 51, kind: 'removed' }, { top: 50, bottom: 51, kind: 'added' },
    { top: 52, bottom: 53, kind: 'removed' },
  ], 100, 100)
  assert.deepEqual(bands[0], bands[2])
  assert.ok(bands[0].bottom <= bands[1].top)
  for (const band of bands) assert.ok(band.bottom - band.top >= 3)
})

test('mixed markers at EOF remain inside the track, including very short tracks', () => {
  for (const height of [2, 100, 420]) {
    const bands = overviewBands([{ top: 999, bottom: 1000, kind: 'removed' }, { top: 999, bottom: 1000, kind: 'added' }], height, 1000)
    assert.ok(bands[0].top >= 0 && bands[1].bottom <= height)
    assert.equal(bands[0].bottom, bands[1].top)
    for (const band of bands) assert.ok(band.bottom > band.top)
  }
})

test('separate changes retain their relative positions', () => {
  assert.deepEqual(overviewBands([{ top: 10, bottom: 20, kind: 'removed' }, { top: 60, bottom: 80, kind: 'added' }], 100, 100),
    [{ top: 10, bottom: 20 }, { top: 60, bottom: 80 }])
  assert.deepEqual(overviewBands([], 100, 100), [])
})
