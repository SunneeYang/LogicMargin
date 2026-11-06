import { ArrowRight } from 'lucide-react'
import { targetLabel } from './model.ts'
import type { ReviewDocument, Target } from './types.ts'

export default function TargetDetails({ review, targets }: { review: ReviewDocument; targets: Target[] }) {
  if (!targets.length) return <div className="empty-state"><p>选择步骤或连线，查看规则与源码依据。</p></div>
  return <div className="target-details">{targets.map(target => {
    const node = target.kind === 'node' ? review.nodes.find(item => item.id === target.id) : undefined
    const edge = target.kind === 'edge' ? review.edges.find(item => item.id === target.id) : undefined
    const scene = target.kind === 'scene' ? review.scenes.find(item => item.id === target.id) : undefined
    return <article className="target-detail" key={`${target.kind}:${target.id}`}>
      <h3 className="panel-title">{targetLabel(review, target)}</h3>
      {node ? <>
        {node.summary && node.summary !== node.detail && <p className="target-summary">{node.summary}</p>}
        <section className="detail-section"><h3>规则说明</h3><p>{node.detail || node.summary || '此步骤尚未补充规则说明。'}</p></section>
        {(node.input || node.output) && <details className="detail-section data-details"><summary>输入与输出</summary><div className="state-change"><div><span>输入</span><strong>{node.input || '未提供'}</strong></div><ArrowRight size={16} /><div><span>输出</span><strong>{node.output || '未提供'}</strong></div></div></details>}
        {!!node.evidence.length && <details className="evidence"><summary>源码依据 · {node.evidence.length} 处</summary>{node.evidence.map((item, index) => <div key={`${item.path}:${item.startLine}:${index}`} className="source-item"><code>{item.symbol}</code><small>{item.path}:{item.startLine}-{item.endLine}</small></div>)}</details>}
      </> : edge ? <section className="detail-section"><h3>流转条件</h3><p>{edge.detail || edge.label || '此连线尚未补充流转条件。'}</p><p>{targetLabel(review, { kind: 'node', id: edge.source })} → {targetLabel(review, { kind: 'node', id: edge.target })}</p></section>
        : scene ? <section className="detail-section"><p>{scene.description || '此场景尚未补充详情。'}</p></section>
          : target.kind === 'review' ? <section className="detail-section"><p>{review.description || '此评审尚未补充详情。'}</p></section>
            : <div className="empty-state"><p>此对象在当前版本中不可用，请切换到对应流程版本查看。</p></div>}
    </article>
  })}</div>
}
