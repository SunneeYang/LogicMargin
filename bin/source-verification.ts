import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseSourceFiles } from '../src/model.ts'
import type { ReviewDocument } from '../src/types.ts'
import type { SourceVerification } from '../src/session-types.ts'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

export async function verifyReviewSources(review: ReviewDocument, sourceRoot: string): Promise<SourceVerification> {
  const root = await realpath(resolve(sourceRoot))
  if (!(await stat(root)).isDirectory()) throw new Error('来源工作区必须是目录')
  const evidence = review.nodes.flatMap(node => node.evidence)
  const declared = review.snapshot.files
  const selected = parseSourceFiles(declared ?? [...new Set(evidence.map(item => item.path))].map(path => ({ path, sha256: '0'.repeat(64) })))
  const covered = new Set(selected.map(file => file.path))
  if (evidence.some(item => !covered.has(item.path))) throw new Error('图内源码依据必须全部包含在来源文件清单中')
  const files: SourceVerification['files'] = []
  let total = 0
  for (const file of selected) {
    const path = await realpath(resolve(root, file.path))
    const inside = relative(root, path)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`来源路径超出工作区：${file.path}`)
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`来源必须是普通文件：${file.path}`)
    if (info.size > MAX_FILE_BYTES || total + info.size > MAX_TOTAL_BYTES) throw new Error('来源文件超过单文件 10 MB 或总计 64 MB 上限')
    const bytes = await readFile(path)
    total += bytes.length
    if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('来源文件超过单文件 10 MB 或总计 64 MB 上限')
    const sha256 = digest(bytes)
    if (declared && file.sha256 !== sha256) throw new Error(`来源文件已变化：${file.path}；当前 SHA-256 为 ${sha256}，请重新核对流程并更新清单`)
    files.push({ path: file.path, sha256 })
    const references = evidence.filter(item => item.path === file.path)
    if (references.length) {
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw new Error(`源码依据不是有效 UTF-8 文本：${file.path}`) }
      const lines = content.replaceAll('\r\n', '\n').split('\n')
      for (const item of references) {
        if (item.startLine < 1 || item.endLine < item.startLine || item.endLine > lines.length) throw new Error(`源码依据行号越界：${file.path}:${item.startLine}–${item.endLine}`)
        const actual = digest(lines.slice(item.startLine - 1, item.endLine).join('\n'))
        if (item.digest !== actual) throw new Error(`源码依据已变化：${file.path}:${item.startLine}–${item.endLine}；当前片段 SHA-256 为 ${actual}，请更新流程及依据`)
      }
    }
  }
  const fingerprint = digest(JSON.stringify(files))
  if (review.snapshot.fingerprint !== fingerprint) throw new Error(`流程快照指纹与来源不符；当前指纹为 ${fingerprint}，请重新核对流程后更新评审文件`)
  return { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint }
}
