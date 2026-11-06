import { useMemo, useState } from 'react'
import { ChevronDown, FileCode2 } from 'lucide-react'
import type { Evidence, ReviewDocument, Target } from './types.ts'
import { collectCodeReferences, diffCodePair, pairCodeReferences, splitDiffLines } from './code-diff.ts'
import type { CodePair, DiffLine } from './code-diff.ts'

interface NodeCodeDiffProps {
  before?: ReviewDocument
  after: ReviewDocument
  targets: Target[]
  beforeLabel?: string
  afterLabel?: string
}

function SourceLocation({ evidence, label }: { evidence?: Evidence; label: string }) {
  return <p className="code-source-location"><span>{label}</span>{evidence ? <code title={`${evidence.path}:${evidence.startLine}–${evidence.endLine}`} aria-label={`${evidence.path}，第 ${evidence.startLine} 至 ${evidence.endLine} 行`}>{evidence.startLine}–{evidence.endLine}</code> : <span>未关联此片段</span>}</p>
}

function SourceText({ evidence, label }: { evidence: Evidence; label: string }) {
  return <section className="code-original" aria-label={`${label}源码片段`}>
    <SourceLocation evidence={evidence} label={label} />
    {evidence.code === undefined ? <p className="code-diff-note">此版本未保存源码片段，只有文件位置。</p>
      : <div className="code-scroll" tabIndex={0} role="region" aria-label={`${label}源码，起始行 ${evidence.startLine}`}><pre><code>{evidence.code || '\n'}</code></pre></div>}
  </section>
}

function DiffTable({ lines, label, side }: { lines: (DiffLine | undefined)[]; label: string; side?: 'before' | 'after' }) {
  return <div className="code-scroll" tabIndex={0} role="region" aria-label={label}>
    <table className="code-diff-table">
      <thead><tr>{side !== 'after' && <th scope="col" className="code-line-number">原行</th>}{side !== 'before' && <th scope="col" className="code-line-number">新行</th>}<th scope="col" className="code-line-mark">变更</th><th scope="col">代码</th></tr></thead>
      <tbody>{lines.map((line, index) => <tr key={index} className={`code-diff-line ${line ? `is-${line.kind}` : 'is-gap'}`}>
        {side !== 'after' && <td className="code-line-number">{line?.beforeLine}</td>}
        {side !== 'before' && <td className="code-line-number">{line?.afterLine}</td>}
        <td className="code-line-mark">{line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ' '}</td><td className="code-line-text"><code>{line?.text || '\u00a0'}</code></td>
      </tr>)}</tbody>
    </table>
  </div>
}

function Comparison({ pair, split, beforeLabel, afterLabel, hasBaseline }: { pair: CodePair; split: boolean; beforeLabel: string; afterLabel: string; hasBaseline: boolean }) {
  const old = pair.before?.evidence
  const current = pair.after?.evidence
  const comparison = useMemo(() => diffCodePair(pair), [pair])
  const rows = useMemo(() => comparison && !comparison.limited ? splitDiffLines(comparison.lines) : [], [comparison])
  if (!comparison || comparison.limited) {
    const missingCode = old && old.code === undefined || current && current.code === undefined
    return <>
      <p className="code-diff-note">{comparison?.limited ? '片段较长，以下展示两个版本的原文，未计算行级差异。'
        : missingCode ? '此评审未保存两侧源码片段。请从对应版本核验源码，重新发起包含代码快照的评审。'
          : pair.ambiguous ? '两侧片段无法唯一对应，以下按各版本保存的原文展示。'
            : !hasBaseline ? '尚未提供比较基线，以下展示当前版本保存的代码依据。'
              : current ? '当前版本关联了此片段；原版未关联，无法据此判断代码是否新增。'
                : '当前版本不再关联此片段，无法据此判断代码是否删除。'}</p>
      <div className={split && old && current ? 'code-diff-split' : 'code-source-stack'}>
        {old && <SourceText evidence={old} label={beforeLabel} />}
        {current && <SourceText evidence={current} label={afterLabel} />}
      </div>
    </>
  }
  const added = comparison.lines.filter(line => line.kind === 'added').length
  const removed = comparison.lines.filter(line => line.kind === 'removed').length
  return <>
    <div className="code-comparison-summary">
      <div className="code-comparison-locations"><SourceLocation evidence={old} label={beforeLabel} /><span aria-hidden="true">→</span><SourceLocation evidence={current} label={afterLabel} /></div>
      <p>{added || removed ? <><span className="code-added-count" aria-label={`新增 ${added} 行`}>+{added}</span><span className="code-removed-count" aria-label={`删除 ${removed} 行`}>−{removed}</span></> : '片段内容相同'}</p>
    </div>
    {split ? <div className="code-diff-split">
      <DiffTable lines={rows.map(row => row.before)} label={`${beforeLabel}代码差异`} side="before" />
      <DiffTable lines={rows.map(row => row.after)} label={`${afterLabel}代码差异`} side="after" />
    </div> : <DiffTable lines={comparison.lines} label="统一代码差异" />}
  </>
}

function CodeSection({ pair, initialOpen, ...props }: { pair: CodePair; initialOpen: boolean; split: boolean; beforeLabel: string; afterLabel: string; hasBaseline: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const evidence = pair.after?.evidence ?? pair.before!.evidence
  const titles = [...new Set([...(pair.before?.nodeTitles ?? []), ...(pair.after?.nodeTitles ?? [])])]
  const multipleNodes = new Set([...(pair.before?.nodeIds ?? []), ...(pair.after?.nodeIds ?? [])]).size > 1
  return <details className="code-evidence-section" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><FileCode2 size={16} aria-hidden="true" /><span><strong>{evidence.symbol || evidence.path}</strong><small title={evidence.path}>{evidence.path}</small></span><ChevronDown size={14} aria-hidden="true" /></summary>
    {open && <div className="code-evidence-body">{multipleNodes && <p className="code-related-nodes">{titles.join(' · ')}</p>}<Comparison pair={pair} {...props} /></div>}
  </details>
}

export default function NodeCodeDiff({ before, after, targets, beforeLabel = '修改前', afterLabel = '当前版本' }: NodeCodeDiffProps) {
  const [split, setSplit] = useState(false)
  const pairs = useMemo(() => pairCodeReferences(before ? collectCodeReferences(before, targets) : [], collectCodeReferences(after, targets)), [before, after, targets])
  if (!targets.length) return <div className="empty-state"><FileCode2 size={24} /><h3>选择要核对的步骤</h3><p>从节点打开代码页，查看它关联的源码片段。</p></div>
  if (!pairs.length) return <div className="empty-state"><FileCode2 size={24} /><h3>尚未关联代码依据</h3><p>请让代理为这些步骤补充源码位置，并在发布评审时保存对应版本的代码片段。</p></div>
  return <section className="node-code-diff" aria-label="相关代码 diff">
    <header className="code-diff-heading"><p title={`${before ? `${beforeLabel} · ${before.revision} · ${before.snapshot.commit}\n` : ''}${afterLabel} · ${after.revision} · ${after.snapshot.commit}`}>{before ? `${beforeLabel} → ${afterLabel}` : afterLabel}</p><div className="code-diff-mode" role="group" aria-label="代码对照布局"><button className="button" aria-pressed={!split} onClick={() => setSplit(false)}>统一</button><button className="button" aria-pressed={split} onClick={() => setSplit(true)}>并排</button></div></header>
    <p className="code-diff-note">{targets.some(target => target.kind === 'edge') ? '仅比较连线两端节点的关联片段，范围见行号。' : '仅比较节点关联片段，范围见行号。'}</p>
    {pairs.map((pair, index) => <CodeSection key={pair.key} pair={pair} initialOpen={index === 0} split={split} beforeLabel={beforeLabel} afterLabel={afterLabel} hasBaseline={!!before} />)}
  </section>
}
