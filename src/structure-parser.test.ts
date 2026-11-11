import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { IterMode } from '@lezer/common'
import { parser } from '@lezer/javascript'

// Run the embedded artifact without Goja's wall-clock budget masking the node guard.
const bundle = readFileSync(new URL('../internal/structure/parser.bundle.js', import.meta.url), 'utf8')
const { parseJSON } = runInNewContext(`${bundle}\nLogicMarginStructure`)

test('embedded parser accepts exactly 150000 tree nodes and rejects 150001', () => {
  const cases = [
    { source: 'x;'.repeat(49_954) + ';;', nodes: 150_000 },
    { source: 'x;'.repeat(49_955), nodes: 150_001 },
  ]
  for (const { source, nodes } of cases) {
    const cursor = parser.configure({ dialect: 'ts' }).parse(source).cursor(IterMode.IncludeAnonymous)
    let count = 1
    while (cursor.next()) count++
    // Anonymous packing nodes count too; grammar changes must revalidate these fixtures.
    assert.equal(count, nodes)
    const result = JSON.parse(parseJSON(source, 'ts'))
    if (nodes > 150_000) {
      assert.deepEqual(result, { error: 'budget' })
    } else {
      assert.equal(result.error, undefined)
      assert.equal(result.parsedAs, 'file')
      assert.equal(result.tokens.length, source.length)
      for (let i = 0; i < source.length; i++) {
        assert.equal(result.tokens[i].from, i)
        assert.equal(result.tokens[i].to, i + 1)
        assert.equal(result.tokens[i].key.endsWith(`:${source[i]}`), true)
      }
      assert.ok(result.shape.length > 0)
    }
  }
})
