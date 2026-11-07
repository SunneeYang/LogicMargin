import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Compartment, EditorState, StateEffect, StateField, Text } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap, lineNumbers } from '@codemirror/view'
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { getChunks, goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from '@codemirror/merge'
import { javascript } from '@codemirror/lang-javascript'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import type { Evidence } from './types.ts'
import { buildUnifiedDiff } from './unified-code-diff.ts'

const unfoldCode = StateEffect.define<number>()

class CollapsedCode extends WidgetType {
  readonly from: number
  readonly lines: number
  constructor(from: number, lines: number) { super(); this.from = from; this.lines = lines }
  toDOM(view: EditorView) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'cm-collapsedLines'
    button.textContent = `${this.lines} 行未修改`
    button.setAttribute('aria-label', `展开 ${this.lines} 行未修改代码`)
    button.onclick = () => { view.dispatch({ effects: unfoldCode.of(this.from) }); view.focus() }
    return button
  }
}

function collapsedCode(diff: ReturnType<typeof buildUnifiedDiff>) {
  return StateField.define({
    create: () => Decoration.set(diff.folds.map(fold => Decoration.replace({
      block: true, widget: new CollapsedCode(fold.from, fold.lines),
    }).range(fold.from, fold.to))),
    update: (decorations, transaction) => {
      for (const effect of transaction.effects) if (effect.is(unfoldCode)) {
        decorations = decorations.update({ filter: from => from !== effect.value })
      }
      return decorations
    },
    provide: field => EditorView.decorations.from(field),
  })
}

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
  const updateExpanded = useRef<(expanded: boolean) => void>(() => {})
  const navigate = useRef<(direction: number) => boolean>(() => false)
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const [summary, setSummary] = useState({ count: 0, precise: true })
  const unifiedCache = useRef<{ before: string; after: string; diff: ReturnType<typeof buildUnifiedDiff> } | null>(null)
  useEffect(() => {
    if (!container.current) return
    // Native unified deletions are whole widgets; long excerpts use ordinary virtualized lines.
    const virtual = !split && Math.max(before.endLine - before.startLine, after.endLine - after.startLine) >= 200
    if (virtual && (unifiedCache.current?.before !== before.code || unifiedCache.current?.after !== after.code)) {
      unifiedCache.current = { before: before.code!, after: after.code!, diff: buildUnifiedDiff(before.code!, after.code!) }
    }
    const unified = virtual ? unifiedCache.current!.diff : null
    const extensions = (evidence: Evidence, label: string, number = (line: number) => String(line + evidence.startLine - 1)) => [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `${label}代码`, 'aria-readonly': 'true' }),
      lineNumbers({ formatNumber: number }),
      syntaxHighlighting(classHighlighter), language(evidence.path),
      keymap.of([{ key: 'F7', run: current => split || !unified ? goToNextChunk(current) : navigate.current(1) },
        { key: 'Shift-F7', run: current => split || !unified ? goToPreviousChunk(current) : navigate.current(-1) }]),
      EditorState.phrases.of({ '$ unchanged lines': '$ 行未修改' }),
    ]
    const options = (full: boolean) => ({ highlightChanges: true, gutter: true, diffConfig: { scanLimit: 2000, timeout: 100 },
      collapseUnchanged: full ? undefined : { margin: 3, minSize: 8 } })
    let editor: EditorView | MergeView
    if (split) {
      const merge = new MergeView({ parent: container.current,
        a: { doc: before.code!, extensions: extensions(before, beforeLabel) },
        b: { doc: after.code!, extensions: extensions(after, afterLabel) }, ...options(expandedRef.current),
      })
      editor = merge
      updateExpanded.current = full => merge.reconfigure({ collapseUnchanged: options(full).collapseUnchanged })
    } else if (unified) {
      const folding = new Compartment()
      const decorations = unified.lines.flatMap((line, index) => line.kind ? [Decoration.line({
        class: line.kind === 'removed' ? 'cm-deletedLine' : 'cm-changedLine',
      }).range(unified.doc.line(index + 1).from)] : [])
      decorations.push(...unified.marks.map(mark => Decoration.mark({
        class: mark.kind === 'removed' ? 'cm-deletedText' : 'cm-changedText',
      }).range(mark.from, mark.to)))
      const oldNumbers = gutter({ class: 'cm-originalLineNumbers', renderEmptyElements: true,
        initialSpacer: () => new SourceLines([before.endLine]),
        lineMarker: (_view, line) => {
          const number = unified.lines[unified.doc.lineAt(line.from).number - 1].before
          return number === undefined ? null : new SourceLines([number + before.startLine - 1])
        },
      })
      const current = new EditorView({ parent: container.current, doc: unified.doc,
        extensions: [oldNumbers, ...extensions(after, afterLabel, line => {
          const number = unified.lines[line - 1]?.after
          return number === undefined ? '' : String(number + after.startLine - 1)
        }), EditorView.editorAttributes.of({ class: 'cm-unified-virtual cm-merge-b' }),
        EditorView.decorations.of(Decoration.set(decorations, true)), folding.of(expandedRef.current ? [] : collapsedCode(unified))],
      })
      editor = current
      updateExpanded.current = full => current.dispatch({ effects: folding.reconfigure(full ? [] : collapsedCode(unified)) })
    } else {
      const state = (full: boolean) => EditorState.create({ doc: after.code!, extensions: [originalNumbers(before),
        ...extensions(after, afterLabel), unifiedMergeView({ original: before.code!, mergeControls: false, ...options(full) })] })
      const current = new EditorView({ parent: container.current, state: state(expandedRef.current) })
      editor = current
      updateExpanded.current = full => current.setState(state(full))
    }
    const applyExpanded = updateExpanded.current
    let currentExpanded = expandedRef.current
    updateExpanded.current = full => {
      if (full === currentExpanded) return
      currentExpanded = full
      applyExpanded(full)
    }
    view.current = editor instanceof MergeView ? editor.b : editor
    navigate.current = direction => {
      const current = view.current!
      if (split || !unified) return direction > 0 ? goToNextChunk(current) : goToPreviousChunk(current)
      if (!unified.changes.length) return false
      const head = current.state.selection.main.head
      const inside = unified.changes.findIndex((from, index) => from <= head && head < unified.changeEnds[index])
      if (inside >= 0 && unified.changes.length === 1) return false
      const position = inside >= 0 ? unified.changes[(inside + direction + unified.changes.length) % unified.changes.length]
        : direction > 0 ? unified.changes.find(position => position > head) ?? unified.changes[0]
          : unified.changes.findLast(position => position < head) ?? unified.changes.at(-1)!
      current.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) })
      current.focus()
      return true
    }
    const chunks = getChunks(view.current.state)?.chunks ?? []
    setSummary(!split && unified ? { count: unified.changes.length, precise: unified.precise }
      : { count: chunks.length, precise: chunks.every(chunk => chunk.precise) })
    return () => { view.current = null; updateExpanded.current = () => {}; navigate.current = () => false; editor.destroy() }
  }, [before, after, beforeLabel, afterLabel, split])
  useEffect(() => updateExpanded.current(expanded), [expanded])
  return <div className={`code-editor ${split ? 'is-split' : 'is-unified'}`}>
    <div className="code-editor-tools">
      <span role="status">{summary.count ? `${summary.count} 处差异` : '片段内容相同'}</span>
      <div className="tool-group"><button className="button icon-button" disabled={!summary.count} aria-label="上一处差异" title="上一处差异 · Shift+F7" onClick={() => navigate.current(-1)}><ArrowUp size={14} /></button>
        <button className="button icon-button" disabled={!summary.count} aria-label="下一处差异" title="下一处差异 · F7" onClick={() => navigate.current(1)}><ArrowDown size={14} /></button>
        <button className="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '折叠未变' : '展开全文'}</button></div>
    </div>
    {!summary.precise && <p className="code-diff-note">差异较大，部分区域仅标出整段变化。</p>}
    <div className="code-editor-labels">{split ? <><span>{beforeLabel} · 原行</span><span>{afterLabel} · 新行</span></> : <span>原行 / 新行 · 删除 / 新增</span>}</div>
    <div ref={container} className="code-editor-host" />
  </div>
}
