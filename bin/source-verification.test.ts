import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { verifyReviewSources } from './source-verification.ts'
import { sampleReview } from '../src/sample.ts'
import type { SourceFile } from '../src/types.ts'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const fingerprint = (files: SourceFile[]) => sha256(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))

async function fixture(t: TestContext, entries: Record<string, string | Buffer> = { 'logic.ts': 'check()\nrun()\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'logic-margin-sources-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const review = structuredClone(sampleReview)
  review.nodes.forEach(node => { node.evidence = [] })
  review.snapshot.files = Object.entries(entries).map(([path, content]) => ({ path, sha256: sha256(content) }))
  review.snapshot.fingerprint = fingerprint(review.snapshot.files)
  return { root, review }
}

test('captures verified evidence and the sorted manifest only after all source checks succeed', async t => {
  const { root, review } = await fixture(t, { 'z.md': '规格\n', 'src/a.ts': 'check()\nrun()\n' })
  review.nodes[0].evidence = [{ path: 'src/a.ts', symbol: 'check', startLine: 1, endLine: 2, digest: sha256('check()\nrun()') }]
  const before = structuredClone(review)
  const result = await verifyReviewSources(review, root)
  assert.equal(result.algorithm, 'sha256-path-content-v1')
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)))
  assert.deepEqual(result.files.map(file => file.path), ['src/a.ts', 'z.md'])
  assert.equal(result.fingerprint, review.snapshot.fingerprint)
  before.nodes[0].evidence[0].code = 'check()\nrun()'
  before.snapshot.files = result.files
  assert.deepEqual(review, before)
  await writeFile(join(root, 'src/a.ts'), 'changed later\n')
  assert.equal(review.nodes[0].evidence[0].code, 'check()\nrun()')
})

test('derives a unique manifest from evidence when a legacy review has no file list', async t => {
  const { root, review } = await fixture(t)
  review.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'check', startLine: 1, endLine: 1, digest: sha256('check()') }]
  review.nodes[1].evidence = structuredClone(review.nodes[0].evidence)
  const expected = review.snapshot.files
  delete review.snapshot.files
  const result = await verifyReviewSources(review, root)
  assert.deepEqual(result.files, expected)
  assert.deepEqual(review.snapshot.files, expected)
  assert.equal(review.nodes[0].evidence[0].code, 'check()')
  assert.equal(review.nodes[1].evidence[0].code, 'check()')
})

test('hashes full-file bytes while normalizing CRLF only for source snippets', async t => {
  const { root, review } = await fixture(t, { 'logic.ts': 'check()\r\nrun()\r\n' })
  review.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'check', startLine: 1, endLine: 2, digest: sha256('check()\nrun()') }]
  const result = await verifyReviewSources(review, root)
  assert.equal(result.files[0].sha256, sha256('check()\r\nrun()\r\n'))
  assert.notEqual(result.files[0].sha256, sha256('check()\nrun()\n'))
  assert.equal(review.nodes[0].evidence[0].code, 'check()\nrun()')
})

test('never partially captures a failed verification or trusts incoming snippet text', async t => {
  const { root, review } = await fixture(t)
  review.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'check', startLine: 1, endLine: 1, digest: sha256('check()'), code: 'forged()' }]
  const fingerprint = review.snapshot.fingerprint
  review.snapshot.fingerprint = '0'.repeat(64)
  const before = structuredClone(review)
  await assert.rejects(verifyReviewSources(review, root), /流程快照指纹与来源不符/)
  assert.deepEqual(review, before)
  review.snapshot.fingerprint = fingerprint
  await verifyReviewSources(review, root)
  assert.equal(review.nodes[0].evidence[0].code, 'check()')
})

test('oversized evidence remains verifiable without retaining an unbounded code payload', async t => {
  for (const content of ['x'.repeat(100_001), Array.from({ length: 2001 }, () => 'x').join('\n')]) {
    const { root, review } = await fixture(t, { 'logic.ts': content })
    review.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'large', startLine: 1, endLine: content.split('\n').length, digest: sha256(content), code: 'untrusted' }]
    await verifyReviewSources(review, root)
    assert.equal(review.nodes[0].evidence[0].code, undefined)
  }
})

test('accepts document-only provenance without node evidence', async t => {
  const { root, review } = await fixture(t, { 'requirements.md': '先验证资格，再扣券。' })
  assert.equal((await verifyReviewSources(review, root)).files[0].path, 'requirements.md')
})

test('rejects stale file hashes, stale snippets and stale snapshot fingerprints', async t => {
  const { root, review } = await fixture(t)
  const changedFile = structuredClone(review)
  changedFile.snapshot.files![0].sha256 = '0'.repeat(64)
  await assert.rejects(verifyReviewSources(changedFile, root), /来源文件已变化/)
  const changedSnippet = structuredClone(review)
  changedSnippet.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'check', startLine: 1, endLine: 1, digest: sha256('before()') }]
  await assert.rejects(verifyReviewSources(changedSnippet, root), /源码依据已变化/)
  review.snapshot.fingerprint = '0'.repeat(64)
  await assert.rejects(verifyReviewSources(review, root), /流程快照指纹与来源不符/)
})

test('rejects uncovered evidence, invalid line ranges and non-UTF8 evidence', async t => {
  const { root, review } = await fixture(t, { 'logic.ts': 'check()', 'opaque.bin': Buffer.from([0xff, 0xfe]) })
  review.nodes[0].evidence = [{ path: 'missing.ts', symbol: 'check', startLine: 1, endLine: 1, digest: sha256('check()') }]
  await assert.rejects(verifyReviewSources(review, root), /全部包含在来源文件清单/)
  review.nodes[0].evidence[0].path = 'logic.ts'
  review.nodes[0].evidence[0].endLine = 2
  await assert.rejects(verifyReviewSources(review, root), /行号越界/)
  review.nodes[0].evidence = [{ path: 'opaque.bin', symbol: 'opaque', startLine: 1, endLine: 1, digest: sha256('unused') }]
  await assert.rejects(verifyReviewSources(review, root), /有效 UTF-8/)
})

test('rejects traversal, absolute and Windows-style manifest paths', async t => {
  const { root, review } = await fixture(t)
  for (const path of ['../logic.ts', '/logic.ts', 'C:/logic.ts', 'src\\logic.ts', 'src/./logic.ts', 'src//logic.ts']) {
    review.snapshot.files![0].path = path
    await assert.rejects(verifyReviewSources(review, root), /规范相对路径/)
  }
})

test('rejects symlinks that leave the source root', async t => {
  const { root, review } = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'logic-margin-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'logic.ts'), 'check()\nrun()\n')
  try { await symlink(join(outside, 'logic.ts'), join(root, 'escape.ts'), 'file') }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'ENOSYS'].includes(String(error.code))) { t.skip('platform cannot create symlinks'); return }
    throw error
  }
  review.snapshot.files![0].path = 'escape.ts'
  await assert.rejects(verifyReviewSources(review, root), /来源路径超出工作区/)
})

test('rejects missing files, directories, empty source lists and oversized files', async t => {
  const { root, review } = await fixture(t)
  review.snapshot.files![0].path = 'missing.ts'
  await assert.rejects(verifyReviewSources(review, root), /ENOENT/)
  await mkdir(join(root, 'directory'))
  review.snapshot.files![0].path = 'directory'
  await assert.rejects(verifyReviewSources(review, root), /普通文件/)
  review.snapshot.files![0].path = 'logic.ts'
  await truncate(join(root, 'logic.ts'), 10 * 1024 * 1024 + 1)
  await assert.rejects(verifyReviewSources(review, root), /10 MB/)
  delete review.snapshot.files
  await assert.rejects(verifyReviewSources(review, root), /来源文件清单不能为空/)
})
