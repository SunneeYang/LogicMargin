import { createHash } from 'node:crypto'
import { parseReview } from '../../src/model.ts'
import type { Evidence, ReviewDocument } from '../../src/types.ts'

const hash = (code: string) => createHash('sha256').update(code).digest('hex')

export function largeCodeReview(): ReviewDocument {
  const original = Array.from({ length: 2000 }, (_, index) => `const item${index} = ${index};`).join('\n')
  const sparse = Array.from({ length: 2000 }, (_, index) => `const item${index} = ${index % 50 === 10 ? index + 10000 : index};`).join('\n')
  const replaced = Array.from({ length: 2000 }, (_, index) => `export const rule${index} = "replacement-${1999 - index}";`).join('\n')
  const cases = [
    { id: 'sparse', title: '2000 行 · 稀疏修改', code: sparse, files: 1 },
    { id: 'replaced', title: '2000 行 · 全部替换', code: replaced, files: 1 },
    { id: 'deleted', title: '2000 行 · 删除 1900 行', code: original.split('\n').slice(1900).join('\n'), files: 1 },
    { id: 'multiple', title: '单节点 · 12 个大文件', code: sparse, files: 12 },
  ]
  const build = (current: boolean): ReviewDocument => {
    const files: { path: string; sha256: string }[] = []
    const nodes = cases.map((item, index) => {
      const evidence: Evidence[] = Array.from({ length: item.files }, (_, file) => {
        const path = `synthetic/${item.id}-${file + 1}.ts`
        const code = current ? item.code : original
        const digest = hash(code)
        files.push({ path, sha256: digest })
        return { path, symbol: `fixture_${item.id}_${file + 1}`, startLine: 1, endLine: code.split('\n').length, code, digest }
      })
      return { id: item.id, sceneId: 'large-code', title: item.title, kind: 'action' as const,
        summary: '只用于代码对照压力测试的合成文本。', detail: '从本节点打开代码 diff，测试布局切换、展开全文、滚动及跨节点阅读。',
        input: '合成源码', output: '只读代码对照', position: { x: 0, y: index * 200 }, evidence }
    })
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { schemaVersion: 1, id: 'synthetic-large-code-diff', title: '单节点大代码 diff · 压力测试',
      description: '合成测试数据，不代表任何真实系统的改动。', revision: current ? 'synthetic-R1' : 'synthetic-B',
      snapshot: { repository: 'LogicMargin synthetic large code fixture', commit: 'unversioned',
        fingerprint: hash(JSON.stringify(files)), capturedAt: '2026-11-07T00:00:00.000Z', dirty: false, files },
      coverage: { included: ['2000行稀疏修改', '2000行全部替换', '1900行删除', '单节点12份2000行片段'],
        excluded: ['真实业务行为', '手机真机性能结论'], note: '固定生成的合成文本，摘要与各版本保存的全文一致。' },
      scenes: [{ id: 'large-code', title: '大代码对照', description: '每个节点代表一种合法的大代码压力输入。' }],
      nodes, edges: [], comments: [] }
  }
  return parseReview({ ...build(true), baseline: build(false) })
}
