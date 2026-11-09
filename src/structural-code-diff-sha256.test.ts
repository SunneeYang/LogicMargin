import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { sha256 } from './structural-code-diff-sha256.ts'

test('HTTP SHA256 fallback matches standard vectors and Node across padding and UTF8 boundaries', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]
  for (const [text, expected] of vectors) assert.equal(sha256(new TextEncoder().encode(text)), expected)
  for (const size of [1, 55, 56, 63, 64, 65, 127, 128, 129, 1024, 100_000]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 17 + i % 19) % 256)
    assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'))
  }
  for (const text of ['Move😀 中文\n', '\r\n', '\uD800', 'a'.repeat(63) + '😀']) {
    assert.equal(sha256(new TextEncoder().encode(text)), createHash('sha256').update(text).digest('hex'))
  }
})
