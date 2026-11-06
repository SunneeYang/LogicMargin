import { createHash } from 'node:crypto'
import { parseSourceFiles } from '../src/model.ts'
import { parsePublication } from '../src/revisions.ts'
import type { ReviewDocument } from '../src/types.ts'

export function validateEvidenceCode(review: ReviewDocument) {
  const evidence = review.nodes.flatMap(node => node.evidence).filter(item => item.code !== undefined)
  if (evidence.length) {
    const files = parseSourceFiles(review.snapshot.files)
    const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    if (review.snapshot.fingerprint !== fingerprint) throw new Error('源码片段的来源清单与快照指纹不一致')
    for (const item of evidence) if (createHash('sha256').update(item.code!).digest('hex') !== item.digest) throw new Error(`源码片段与摘要不一致：${item.path}:${item.startLine}–${item.endLine}`)
  }
  if (review.baseline) validateEvidenceCode(review.baseline)
}

export function validatePublication(value: unknown, review: ReviewDocument) {
  const publication = parsePublication(value)
  const files = parseSourceFiles(publication.source.files)
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  if (publication.source.fingerprint !== fingerprint || review.snapshot.fingerprint !== fingerprint) throw new Error('来源清单与流程快照指纹不一致，请重新核对修改后的源码或文档')
  if (!review.snapshot.files || JSON.stringify(parseSourceFiles(review.snapshot.files)) !== JSON.stringify(files)) throw new Error('流程必须包含与本轮核验一致的来源文件清单')
  const paths = new Set(files.map(file => file.path))
  for (const node of review.nodes) for (const evidence of node.evidence) {
    if (!paths.has(evidence.path) || !/^[a-f0-9]{64}$/.test(evidence.digest)) throw new Error('流程依据未包含在已核验的来源文件中，或片段摘要无效')
  }
  return publication
}
