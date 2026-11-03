import { createHash } from 'node:crypto'
import { parseSourceFiles } from '../src/model.ts'
import { parsePublication } from '../src/revisions.ts'
import type { ReviewDocument } from '../src/types.ts'

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
