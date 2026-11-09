import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { parseReview } from '../../src/model.ts'
import type { Evidence } from '../../src/types.ts'
import { contextReview } from './context-review.ts'

export interface StructuralCase {
  id: string
  language: string
  before: string
  after: string
  mode?: 'structural' | 'text'
  reason?: string
  formattingOnly: boolean
  moved?: { name: string; modified: boolean }
  noMoves?: boolean
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const typedBefore = '// 中文😀：固定合成输入\nexport function accepts(value:number,limit:number):boolean {\n const label:string="旧标签😀";\n // 旧注释\n if(value<limit){return label.length>0;}\n return false;\n}'
const typedFormatted = '// 中文😀：固定合成输入\nexport function accepts( value: number, limit: number ): boolean {\n  const label: string = "旧标签😀";\n  // 旧注释\n  if (value < limit) { return label.length > 0; }\n  return false;\n}'

function goFunction(name: string, seed: number, changed = false, lines = 100) {
  return [`func ${name}(value int) int {`, `\t// 函数 ${name} 😀 固定内容`, `\ttotal := value + ${seed}`, ...Array.from({ length: lines }, (_, index) =>
    `\ttotal += ${seed + index + (changed && (index === 22 || index === lines - 23) ? 7 : 0)}`), '\treturn total', '}'].join('\n')
}

const alpha = goFunction('Alpha', 17), beta = goFunction('Beta', 419), gamma = goFunction('Gamma', 809)
const goFile = (...functions: string[]) => ['package synthetic', '// 中文😀：行号来自保存片段，文件不在工作区。', ...functions].join('\n\n')

export const structuralCases: StructuralCase[] = [
  { id: 'ts-format', language: 'ts', before: typedBefore, after: typedFormatted, mode: 'structural', formattingOnly: true, noMoves: true },
  { id: 'ts-semantic', language: 'ts', before: typedBefore,
    after: typedFormatted.replace('value < limit', 'value <= limit').replace('旧标签😀', '新标签😁').replace('旧注释', '新注释'),
    mode: 'structural', formattingOnly: false, noMoves: true },
  { id: 'go-move-modified', language: 'go', before: goFile(alpha, beta, gamma),
    after: goFile(beta, gamma, goFunction('Alpha', 17, true)), mode: 'structural', formattingOnly: false,
    moved: { name: 'Alpha', modified: true } },
  { id: 'go-move-only', language: 'go', before: goFile(alpha, beta, gamma), after: goFile(beta, gamma, alpha),
    mode: 'structural', formattingOnly: false, moved: { name: 'Alpha', modified: false } },
  { id: 'offset-only', language: 'go', before: goFile(alpha, beta, gamma), after: goFile('// 新增说明😀', alpha, beta, gamma),
    mode: 'structural', formattingOnly: false, noMoves: true },
  { id: 'duplicate-name', language: 'go', before: goFile('func Echo() int { return 11 }', 'func Echo() int { return 29 }'),
    after: goFile('func Echo() int { return 29 }', 'func Echo() int { return 11 }'), formattingOnly: false, noMoves: true },
  { id: 'duplicate-body', language: 'go', before: goFile('func One() int { return 1 }', 'func Two() int { return 1 }', 'func Three() int { return 1 }'),
    after: goFile('func Two() int { return 1 }', 'func Three() int { return 1 }', 'func One() int { return 1 }'),
    formattingOnly: false, noMoves: true },
  { id: 'truncated', language: 'ts', before: 'function unfinished(value: number) {\n  if (value < 3) {\n    return value;',
    after: 'function unfinished(value: number) {\n  if (value <= 3) {\n    return value;', mode: 'text', reason: 'invalid-syntax', formattingOnly: false, noMoves: true },
  { id: 'js-asi', language: 'js', before: 'function result() { return { value: "中文😀" }; }',
    after: 'function result() { return\n { value: "中文😀" }; }', formattingOnly: false, noMoves: true },
  { id: 'jsx', language: 'jsx', before: 'export function Card() { return <div title="旧😀">内容</div>; }',
    after: 'export function Card() { return <div title="新😁">内容</div>; }', mode: 'structural', formattingOnly: false, noMoves: true },
  { id: 'tsx', language: 'tsx', before: 'export function Card({ count }: { count: number }) { return <b>{count < 3 ? "少" : "多"}</b>; }',
    after: 'export function Card({ count }: { count: number }) { return <b>{count <= 3 ? "少" : "多"}</b>; }', mode: 'structural', formattingOnly: false, noMoves: true },
  { id: 'unsupported', language: 'txt', before: '中文😀: old value', after: '中文😀: new value',
    mode: 'text', reason: 'unsupported-language', formattingOnly: false, noMoves: true },
]

/** Comment padding exercises virtual lines; dense syntax budgets are measured separately. */
export function structuralReadingCase(lines = 194): StructuralCase {
  const sample = structuralCases.find(item => item.id === 'ts-semantic')!
  const context = Array.from({ length: lines - sample.before.split('\n').length + 1 }, (_, index) => `// context${index}: number = ${index};`)
  const original = [...context], changed = [...context]
  original.splice(25, 0, sample.before)
  changed.splice(25, 0, sample.after)
  changed[lines - 28] = changed[lines - 28].replace(/= \d+;/, '= 99001;')
  return { ...sample, id: `ts-reading-${lines}`, before: original.join('\n'), after: changed.join('\n') }
}

export function structuralReview(sample: StructuralCase = structuralReadingCase()) {
  const review = contextReview(194)
  review.id = `synthetic-structure-${sample.id}`
  review.title = '结构差异 · 固定合成输入'
  review.baseline!.id = review.id
  const alternate = { before: 'export const alternate: string = "切换前😀";', after: 'export const alternate: string = "切换后😁";' }
  for (const [document, side] of [[review.baseline!, 'before'], [review, 'after']] as const) {
    const original = document.nodes[0]
    const sources = [{ id: 'sparse', title: `结构用例 ${sample.id}`, code: sample[side], path: `synthetic/structure/${sample.id}.${sample.language}`, startLine: 101 },
      { id: 'alternate', title: '另一个保存节点', code: alternate[side], path: 'synthetic/structure/alternate.ts', startLine: 401 }]
    document.nodes = sources.map((source, index) => ({ ...structuredClone(original), id: source.id, title: source.title,
      position: { x: 0, y: index * 200 }, evidence: [{ path: source.path, symbol: source.id, startLine: source.startLine,
        endLine: source.startLine + source.code.split('\n').length - 1, code: source.code, digest: hash(source.code) }] }))
    const files = sources.map(source => ({ path: source.path, sha256: hash(savedFile(source.code, source.startLine)) })).sort((a, b) => a.path.localeCompare(b.path))
    document.snapshot = { ...document.snapshot, repository: 'LogicMargin synthetic structural fixture', files, fingerprint: hash(JSON.stringify(files)) }
    document.coverage = { included: ['保存的合成源码', 'UTF-16 与原文件行号', '两个节点'], excluded: ['工作区源码', '真实业务行为'], note: '不读取工作区，不包含私有评审输入。' }
  }
  return review
}

export function savedFile(code: string, startLine: number) {
  return `${'// 保存的合成上下文😀\n'.repeat(startLine - 1)}${code}`
}

export function structuralReference({ path, symbol, startLine, endLine, digest }: Evidence) {
  return { path, symbol, startLine, endLine, digest }
}

export function structuralInput(review: ReturnType<typeof structuralReview>) {
  return { beforeSnapshot: { kind: 'baseline' as const }, afterSnapshot: { kind: 'round' as const, round: 1 },
    before: structuralReference(review.baseline!.nodes[0].evidence[0]), after: structuralReference(review.nodes[0].evidence[0]) }
}

export function validateStructuralFixture(review = structuralReview()) {
  parseReview(review)
  assert.equal(review.nodes.length, 2)
  for (const document of [review.baseline!, review]) {
    assert.equal(document.snapshot.fingerprint, hash(JSON.stringify(document.snapshot.files)))
    for (const node of document.nodes) for (const evidence of node.evidence) {
      assert.equal(evidence.digest, hash(evidence.code!))
      assert.equal(evidence.endLine, evidence.startLine + evidence.code!.split('\n').length - 1)
      assert.equal(document.snapshot.files!.find(file => file.path === evidence.path)?.sha256, hash(savedFile(evidence.code!, evidence.startLine)))
      assert.ok(evidence.path.startsWith('synthetic/structure/'))
    }
  }
  return review
}
