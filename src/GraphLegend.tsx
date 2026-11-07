import { useEffect, useState } from 'react'
import { Diamond, Flag, Info, LogOut, SlidersHorizontal, Square } from 'lucide-react'
import { useI18n } from './i18n.ts'

export type NodeAppearance = 'plain' | 'distinct'

export default function GraphLegend({ nodeAppearance, onNodeAppearanceChange }: {
  nodeAppearance: NodeAppearance
  onNodeAppearanceChange: (appearance: NodeAppearance) => void
}) {
  const { t } = useI18n()
  const [settingsOpen, setSettingsOpen] = useState(() => !window.matchMedia('(max-width: 900px)').matches)
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 900px)')
    const update = () => setSettingsOpen(!compact.matches)
    compact.addEventListener('change', update)
    return () => compact.removeEventListener('change', update)
  }, [])

  return <details className="canvas-reading-guide" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)} onKeyDown={event => {
    if (event.key === 'Escape' && window.matchMedia('(max-width: 900px)').matches) {
      setSettingsOpen(false)
      event.stopPropagation()
      event.currentTarget.querySelector<HTMLElement>(':scope > summary')?.focus()
    }
  }}>
    <summary className="button display-settings-toggle"><SlidersHorizontal size={14} />{t('显示设置')}</summary>
    <div className="canvas-display-options">
    <div className="node-appearance-switch" role="group" aria-label={t('节点显示方式')} data-keep-composer>
      <button className={`button ${nodeAppearance === 'plain' ? 'active' : ''}`} aria-pressed={nodeAppearance === 'plain'} onClick={() => onNodeAppearanceChange('plain')}>{t('简洁')}</button>
      <button className={`button ${nodeAppearance === 'distinct' ? 'active' : ''}`} aria-pressed={nodeAppearance === 'distinct'} onClick={() => onNodeAppearanceChange('distinct')}>{t('多样式')}</button>
    </div>
    <details className="canvas-legend" onKeyDown={event => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.stopPropagation() }
    }}>
      <summary className="button"><Info size={14} />{t('图例')}</summary>
      <div className="canvas-legend-panel" aria-label={t('流程图图例')}>
        <h3>{t('节点类型')}</h3>
        <dl>
          <div><dt>{nodeAppearance === 'distinct' && <span className="node-type-swatch kind-action" aria-hidden="true" />}<Square size={14} aria-hidden="true" />{t('操作')}</dt><dd>{t('执行一个步骤')}</dd></div>
          <div><dt>{nodeAppearance === 'distinct' && <span className="node-type-swatch kind-decision" aria-hidden="true" />}<Diamond size={14} aria-hidden="true" />{t('判断')}</dt><dd>{t('按条件选择分支')}</dd></div>
          <div><dt>{nodeAppearance === 'distinct' && <span className="node-type-swatch kind-result" aria-hidden="true" />}<Flag size={14} aria-hidden="true" />{t('结果')}</dt><dd>{t('正常完成或产出')}</dd></div>
          <div><dt>{nodeAppearance === 'distinct' && <span className="node-type-swatch kind-failure" aria-hidden="true" />}<LogOut size={14} aria-hidden="true" />{t('失败出口')}</dt><dd>{t('拒绝、中断或异常')}</dd></div>
        </dl>
        <p>{t(nodeAppearance === 'plain'
          ? '节点统一实线边框，类型由图标和文字区分；强调色外框表示选中。'
          : '蓝色矩形表示操作，琥珀色直角卡片表示判断，绿色圆角卡片表示结果，红色侧条卡片表示失败出口。图标和文字始终保留；强调色外框表示选中，颜色不代表节点已通过评审。')}</p>
        <h3>{t('连线与交叉')}</h3>
        <svg className="legend-crossing" viewBox="0 0 140 42" aria-hidden="true">
          <path d="M8 21H132" className="legend-wire" />
          <path d="M70 4V38" className="edge-crossing-gap" strokeWidth="8" />
          <path d="M70 4V38" className="legend-wire" />
        </svg>
        <p>{t('连线沿通道转折，外围虚线表示返回前序步骤，较细连线通向失败出口。留白交叉表示跨过、不连接。分支和汇合只发生在节点端口；箭头表示流向。')}</p>
        <p><span className="flow-key incoming">{t('前序 →')}</span>{t(' 流入选中节点；')}<span className="flow-key outgoing">{t('→ 后续')}</span>{t(' 从选中节点流出。关联连线使用强调色，流动光效沿箭头前进，其他条件保持可读。')}</p>
        <h3>{t('操作')}</h3><p>{t('滚轮或触控板双指滑动可平移画布；按住 Ctrl / ⌘ 滚动，或双指捏合可缩放。也可拖动画布。点击选择步骤或连线，右键批注；按住 Shift / ⌘ 可多选，框选只选择节点。')}</p>
        <h3>{t('跨轮变化')}</h3>
        <div className="legend-revisions">
          <span className="badge revision-badge revision-added">{t('新增')}</span>
          <span className="badge revision-badge revision-changed">{t('已修改')}</span>
          <span className="badge revision-badge revision-removed">{t('已移除')}</span>
          <span className="badge revision-badge revision-evidence">{t('依据更新')}</span>
        </div>
        <p>{t('差异标在当前实现图；基线 B 保持原版。文字徽标不代表节点已通过评审。')}</p>
      </div>
    </details>
    </div>
  </details>
}
