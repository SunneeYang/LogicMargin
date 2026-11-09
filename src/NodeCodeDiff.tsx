import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { ChevronDown, FileCode2 } from 'lucide-react'
import type { Evidence, ReviewDocument, Target } from './types.ts'
import { collectCodeReferences, pairCodeReferences } from './code-diff.ts'
import type { CodePair } from './code-diff.ts'
import type { DiffContext } from './precompute.ts'
import type CodeDiffEditor from './CodeDiffEditor.tsx'
import { useI18n } from './i18n.ts'

let loadedEditor: typeof CodeDiffEditor | null = null

function DeferredCodeDiffEditor(props: ComponentProps<typeof CodeDiffEditor>) {
  const { t } = useI18n()
  const [Editor, setEditor] = useState(() => loadedEditor)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (Editor) return
    let active = true
    // Keep the code chunk lazy without Suspense's fallback reveal delay on first open.
    void import('./CodeDiffEditor.tsx').then(module => {
      loadedEditor = module.default
      if (active) setEditor(() => module.default)
    }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  return Editor ? <Editor {...props} /> : <p role={failed ? 'alert' : 'status'} className="code-diff-note">
    {t(failed ? '代码视图暂时无法打开，请刷新页面后重试。' : '正在加载代码对照…')}
  </p>
}

interface NodeCodeDiffProps {
  before?: ReviewDocument
  after: ReviewDocument
  targets: Target[]
  beforeLabel?: string
  afterLabel?: string
  precomputeContext?: DiffContext
}

function SourceLocation({ evidence, label }: { evidence?: Evidence; label: string }) {
  const { t } = useI18n()
  return <p className="code-source-location"><span>{label}</span>{evidence ? <code title={`${evidence.path}:${evidence.startLine}–${evidence.endLine}`} aria-label={t('{path}，第 {start} 至 {end} 行', { path: evidence.path, start: evidence.startLine, end: evidence.endLine })}>{evidence.startLine}–{evidence.endLine}</code> : <span>{t('未关联此片段')}</span>}</p>
}

function SourceText({ evidence, label }: { evidence: Evidence; label: string }) {
  const { t } = useI18n()
  return <section className="code-original" aria-label={t('{label}源码片段', { label })}>
    <SourceLocation evidence={evidence} label={label} />
    {evidence.code === undefined ? <p className="code-diff-note">{t('此版本未保存源码片段，只有文件位置。')}</p>
      : <div className="code-scroll" tabIndex={0} role="region" aria-label={t('{label}源码，起始行 {line}', { label, line: evidence.startLine })}><pre><code>{evidence.code || '\n'}</code></pre></div>}
  </section>
}

function Comparison({ pair, split, beforeLabel, afterLabel, hasBaseline, precomputeContext }: { pair: CodePair; split: boolean; beforeLabel: string; afterLabel: string; hasBaseline: boolean; precomputeContext?: DiffContext }) {
  const { t } = useI18n()
  const old = pair.before?.evidence
  const current = pair.after?.evidence
  if (old?.code === undefined || current?.code === undefined) {
    const missingCode = old && old.code === undefined || current && current.code === undefined
    return <>
      <p className="code-diff-note">{t(missingCode ? '此评审未保存两侧源码片段。请从对应版本核验源码，重新发起包含代码快照的评审。'
          : pair.ambiguous ? '两侧片段无法唯一对应，以下按各版本保存的原文展示。'
            : !hasBaseline ? '尚未提供比较基线，以下展示当前版本保存的代码依据。'
              : current ? '当前版本关联了此片段；原版未关联，无法据此判断代码是否新增。'
                : '当前版本不再关联此片段，无法据此判断代码是否删除。')}</p>
      <div className={split && old && current ? 'code-diff-split' : 'code-source-stack'}>
        {old && <SourceText evidence={old} label={beforeLabel} />}
        {current && <SourceText evidence={current} label={afterLabel} />}
      </div>
    </>
  }
  return <>
    <div className="code-comparison-locations"><SourceLocation evidence={old} label={beforeLabel} /><span aria-hidden="true">→</span><SourceLocation evidence={current} label={afterLabel} /></div>
    <DeferredCodeDiffEditor before={old} after={current} beforeLabel={beforeLabel} afterLabel={afterLabel} split={split} precomputeContext={precomputeContext} />
  </>
}

function CodeSection({ pair, initialOpen, split, ...props }: { pair: CodePair; initialOpen: boolean; split: boolean; beforeLabel: string; afterLabel: string; hasBaseline: boolean; precomputeContext?: DiffContext }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(initialOpen)
  const [layout, setLayout] = useState<boolean | null>(initialOpen ? split : null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || !body.current) return
    // Offscreen files keep their current view until scrolling brings them into use.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setLayout(split)
    }, { rootMargin: '160px 0px' })
    observer.observe(body.current)
    return () => observer.disconnect()
  }, [open, split])
  const evidence = pair.after?.evidence ?? pair.before!.evidence
  const titles = [...new Set([...(pair.before?.nodeTitles ?? []), ...(pair.after?.nodeTitles ?? [])])]
  const multipleNodes = new Set([...(pair.before?.nodeIds ?? []), ...(pair.after?.nodeIds ?? [])]).size > 1
  return <details className="code-evidence-section" open={open} onToggle={event => {
    setOpen(event.currentTarget.open)
    if (!event.currentTarget.open) setLayout(null)
  }}>
    <summary><FileCode2 size={16} aria-hidden="true" /><span><strong>{evidence.symbol || evidence.path}</strong><small title={evidence.path}>{evidence.path}</small></span><ChevronDown size={14} aria-hidden="true" /></summary>
    {open && <div ref={body} className="code-evidence-body" data-code-layout={layout === null ? 'pending' : layout ? 'split' : 'unified'} aria-busy={layout === null}>
      {multipleNodes && <p className="code-related-nodes">{titles.join(' · ')}</p>}
      {layout === null ? <p className="code-diff-note code-evidence-placeholder">{t('正在加载代码对照…')}</p> : <Comparison pair={pair} split={layout} {...props} />}
    </div>}
  </details>
}

export default function NodeCodeDiff({ before, after, targets, beforeLabel, afterLabel, precomputeContext }: NodeCodeDiffProps) {
  const { t } = useI18n()
  beforeLabel ??= t('修改前')
  afterLabel ??= t('当前版本')
  const [split, setSplit] = useState(false)
  const pairs = useMemo(() => pairCodeReferences(before ? collectCodeReferences(before, targets) : [], collectCodeReferences(after, targets)), [before, after, targets])
  if (!targets.length) return <div className="empty-state"><FileCode2 size={24} /><h3>{t('选择要核对的步骤')}</h3><p>{t('从节点打开代码页，查看它关联的源码片段。')}</p></div>
  if (!pairs.length) return <div className="empty-state"><FileCode2 size={24} /><h3>{t('尚未关联代码依据')}</h3><p>{t('请让代理为这些步骤补充源码位置，并在发布评审时保存对应版本的代码片段。')}</p></div>
  return <section className="node-code-diff" aria-label={t('相关代码 diff')}>
    <header className="code-diff-heading"><p title={`${before ? `${beforeLabel} · ${before.revision} · ${before.snapshot.commit}\n` : ''}${afterLabel} · ${after.revision} · ${after.snapshot.commit}`}>{before ? `${beforeLabel} → ${afterLabel}` : afterLabel}</p><div className="code-diff-mode" role="group" aria-label={t('代码对照布局')}><button className="button" aria-pressed={!split} onClick={() => setSplit(false)}>{t('统一')}</button><button className="button" aria-pressed={split} onClick={() => setSplit(true)}>{t('并排')}</button></div></header>
    <p className="code-diff-note">{t(targets.some(target => target.kind === 'edge') ? '仅比较连线两端节点的关联片段，范围见行号。' : '仅比较节点关联片段，范围见行号。')}</p>
    {pairs.map((pair, index) => <CodeSection key={pair.key} pair={pair} initialOpen={index === 0} split={split} beforeLabel={beforeLabel} afterLabel={afterLabel} hasBaseline={!!before} precomputeContext={precomputeContext} />)}
  </section>
}
