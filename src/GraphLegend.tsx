import { Info } from 'lucide-react'

export default function GraphLegend({ hasFocus }: { hasFocus: boolean }) {
  return <div className="canvas-reading-guide">
    {hasFocus && <div className="flow-focus-guide" role="status">
      <span className="flow-key incoming">前序 →</span><span>选中节点</span><span className="flow-key outgoing">→ 后续</span>
    </div>}
    <details className="canvas-legend" onKeyDown={event => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.stopPropagation() }
    }}>
      <summary className="button"><Info size={14} />图例</summary>
      <div className="canvas-legend-panel" aria-label="流程图图例">
        <h3>节点类型</h3>
        <dl>
          <div><dt><i className="legend-node" />操作</dt><dd>实线 · 执行一个步骤</dd></div>
          <div><dt><i className="legend-node decision" />判断</dt><dd>虚线 · 按条件选择分支</dd></div>
          <div><dt><i className="legend-node result" />结果</dt><dd>绿色 · 正常完成或产出</dd></div>
          <div><dt><i className="legend-node failure" />失败出口</dt><dd>黄色 · 拒绝、中断或失败</dd></div>
        </dl>
        <h3>连线与交叉</h3>
        <svg className="legend-crossing" viewBox="0 0 140 42" aria-hidden="true">
          <path d="M8 21H132" className="legend-wire" />
          <path d="M70 4V38" className="edge-crossing-gap" strokeWidth="8" />
          <path d="M70 4V38" className="legend-wire" />
        </svg>
        <p>留白交叉表示跨过、不连接。分支和汇合只发生在节点端口；箭头表示流向。</p>
        <p><span className="flow-key incoming">前序 →</span> 流入选中节点；<span className="flow-key outgoing">→ 后续</span> 从选中节点流出。流动光效沿箭头前进，无关连线淡化。</p>
        <h3>跨轮变化</h3>
        <div className="legend-revisions">
          <span className="badge revision-badge revision-added">新增</span>
          <span className="badge revision-badge revision-changed">已修改</span>
          <span className="badge revision-badge revision-removed">已移除</span>
          <span className="badge revision-badge revision-evidence">依据更新</span>
        </div>
        <p>变化以文字徽标标明，不代表节点已通过评审。</p>
      </div>
    </details>
  </div>
}
