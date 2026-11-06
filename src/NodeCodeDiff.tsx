import { lazy, Suspense, useMemo, useState } from 'react'
import { ChevronDown, FileCode2 } from 'lucide-react'
import type { Evidence, ReviewDocument, Target } from './types.ts'
import { collectCodeReferences, pairCodeReferences } from './code-diff.ts'
import type { CodePair } from './code-diff.ts'

const CodeDiffEditor = lazy(() => import('./CodeDiffEditor.tsx'))

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

function Comparison({ pair, split, beforeLabel, afterLabel, hasBaseline }: { pair: CodePair; split: boolean; beforeLabel: string; afterLabel: string; hasBaseline: boolean }) {
  const old = pair.before?.evidence
  const current = pair.after?.evidence
  if (old?.code === undefined || current?.code === undefined) {
    const missingCode = old && old.code === undefined || current && current.code === undefined
    return <>
      <p className="code-diff-note">{missingCode ? '此评审未保存两侧源码片段。请从对应版本核验源码，重新发起包含代码快照的评审。'
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
  return <>
    <div className="code-comparison-locations"><SourceLocation evidence={old} label={beforeLabel} /><span aria-hidden="true">→</span><SourceLocation evidence={current} label={afterLabel} /></div>
    <Suspense fallback={<p role="status" className="code-diff-note">正在加载代码对照…</p>}>
      <CodeDiffEditor before={old} after={current} beforeLabel={beforeLabel} afterLabel={afterLabel} split={split} />
    </Suspense>
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
