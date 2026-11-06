import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { EditorState, Text } from '@codemirror/state'
import { EditorView, GutterMarker, gutter, keymap, lineNumbers } from '@codemirror/view'
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { getChunks, goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from '@codemirror/merge'
import { javascript } from '@codemirror/lang-javascript'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import type { Evidence } from './types.ts'

function language(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'go') return go()
  if (extension === 'lua') return StreamLanguage.define(lua)
  if (extension === 'json') return json()
  if (extension === 'md' || extension === 'markdown') return markdown()
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension ?? '')) return javascript({ typescript: extension === 'ts' || extension === 'tsx', jsx: extension === 'jsx' || extension === 'tsx' })
  return []
}

class SourceLines extends GutterMarker {
  readonly numbers: number[]
  constructor(numbers: number[]) { super(); this.numbers = numbers }
  eq(other: SourceLines) { return this.numbers.join(',') === other.numbers.join(',') }
  toDOM() {
    const column = document.createElement('span')
    for (const number of this.numbers) {
      const line = column.appendChild(document.createElement('span'))
      line.className = 'code-original-number'; line.textContent = String(number)
    }
    return column
  }
}

function originalNumbers(before: Evidence) {
  const original = Text.of(before.code!.split('\n'))
  return gutter({
    class: 'cm-originalLineNumbers', renderEmptyElements: true,
    initialSpacer: () => new SourceLines([before.endLine]),
    lineMarker(view, line) {
      let offset = 0
      for (const chunk of getChunks(view.state)?.chunks ?? []) {
        if (line.from < chunk.fromB) break
        if (line.from < chunk.toB) return null
        offset = chunk.toA - chunk.toB
      }
      const position = Math.min(original.length, Math.max(0, line.from + offset))
      return new SourceLines([original.lineAt(position).number + before.startLine - 1])
    },
    widgetMarker(view, _widget, block) {
      const chunk = getChunks(view.state)?.chunks.find(chunk => chunk.fromB === block.from && chunk.toA > chunk.fromA)
      if (!chunk) return null
      const start = original.lineAt(chunk.fromA).number
      const end = original.lineAt(chunk.endA).number
      return new SourceLines(Array.from({ length: end - start + 1 }, (_, index) => before.startLine + start - 1 + index))
    },
  })
}

export default function CodeDiffEditor({ before, after, beforeLabel, afterLabel, split }: {
  before: Evidence; after: Evidence; beforeLabel: string; afterLabel: string; split: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [summary, setSummary] = useState({ count: 0, precise: true })
  useEffect(() => {
    if (!container.current) return
    const extensions = (evidence: Evidence, label: string) => [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `${label}代码`, 'aria-readonly': 'true' }),
      lineNumbers({ formatNumber: number => String(number + evidence.startLine - 1) }),
      syntaxHighlighting(classHighlighter), language(evidence.path),
      keymap.of([{ key: 'F7', run: goToNextChunk }, { key: 'Shift-F7', run: goToPreviousChunk }]),
      EditorState.phrases.of({ '$ unchanged lines': '$ 行未修改' }),
    ]
    const options = { highlightChanges: true, gutter: true, diffConfig: { scanLimit: 2000, timeout: 100 },
      collapseUnchanged: expanded ? undefined : { margin: 3, minSize: 8 } }
    const editor = split ? new MergeView({ parent: container.current,
      a: { doc: before.code!, extensions: extensions(before, beforeLabel) },
      b: { doc: after.code!, extensions: extensions(after, afterLabel) }, ...options,
    }) : new EditorView({ parent: container.current, doc: after.code!,
      extensions: [originalNumbers(before), ...extensions(after, afterLabel), unifiedMergeView({ original: before.code!, mergeControls: false, ...options })],
    })
    view.current = editor instanceof MergeView ? editor.b : editor
    const chunks = getChunks(view.current.state)?.chunks ?? []
    setSummary({ count: chunks.length, precise: chunks.every(chunk => chunk.precise) })
    return () => { view.current = null; editor.destroy() }
  }, [before, after, beforeLabel, afterLabel, split, expanded])
  return <div className={`code-editor ${split ? 'is-split' : 'is-unified'}`}>
    <div className="code-editor-tools">
      <span role="status">{summary.count ? `${summary.count} 处差异` : '片段内容相同'}</span>
      <div className="tool-group"><button className="button icon-button" disabled={!summary.count} aria-label="上一处差异" title="上一处差异 · Shift+F7" onClick={() => { if (view.current) goToPreviousChunk(view.current) }}><ArrowUp size={14} /></button>
        <button className="button icon-button" disabled={!summary.count} aria-label="下一处差异" title="下一处差异 · F7" onClick={() => { if (view.current) goToNextChunk(view.current) }}><ArrowDown size={14} /></button>
        <button className="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '折叠未变' : '展开全文'}</button></div>
    </div>
    {!summary.precise && <p className="code-diff-note">差异较大，部分区域仅标出整段变化。</p>}
    <div className="code-editor-labels">{split ? <><span>{beforeLabel} · 原行</span><span>{afterLabel} · 新行</span></> : <span>原行 / 新行 · 删除 / 新增</span>}</div>
    <div ref={container} className="code-editor-host" />
  </div>
}
