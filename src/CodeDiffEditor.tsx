import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Compartment, EditorState, StateEffect, StateField, Text } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, lineNumbers } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { getChunks, goToNextChunk, goToPreviousChunk, mergeViewSiblings, MergeView, unifiedMergeView } from '@codemirror/merge'
import { javascript } from '@codemirror/lang-javascript'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import type { Evidence } from './types.ts'
import { buildUnifiedDiff } from './unified-code-diff.ts'
import { CONTEXT_LINES, contextFolds, expandContextFold } from './code-context.ts'
import type { ContextEdge, ContextFold } from './code-context.ts'
import { codeOverview } from './code-overview.ts'
import type { OverviewRange } from './code-overview.ts'
import { useI18n } from './i18n.ts'

const unfoldCode = StateEffect.define<{ id: number; edge: ContextEdge }>()

// Keep controls inside each column without changing CodeMirror's long-line measurements.
const contextControls = ViewPlugin.define(view => {
  const measure = () => view.requestMeasure({
    key: contextControls,
    read: current => {
      const gutters = [...current.dom.querySelectorAll<HTMLElement>('.cm-gutters')]
      const width = Math.min(current.scrollDOM.clientWidth, current.scrollDOM.getBoundingClientRect().width) - parseFloat(getComputedStyle(current.scrollDOM).paddingRight)
      return { width: Math.max(0, width - gutters.reduce((sum, gutter) => sum + gutter.getBoundingClientRect().width, 0)),
        left: current.dom.querySelector<HTMLElement>('.cm-gutters-before')?.getBoundingClientRect().width ?? 0 }
    },
    write: ({ width, left }, current) => {
      for (const [name, value] of [['--code-context-width', width], ['--code-context-left', left]] as const) {
        if (current.dom.style.getPropertyValue(name) !== `${value}px`) current.dom.style.setProperty(name, `${value}px`)
      }
    },
  })
  measure()
  return { update(update: ViewUpdate) { if (update.geometryChanged) measure() } }
})

class CollapsedCode extends WidgetType {
  readonly fold: ContextFold
  constructor(fold: ContextFold) { super(); this.fold = fold }
  toDOM(view: EditorView) {
    const row = document.createElement('div')
    const { fold } = this
    const count = view.state.doc.lineAt(fold.to).number - view.state.doc.lineAt(fold.from).number + 1
    row.className = 'code-context-fold'; row.dataset.foldId = String(fold.id); row.dataset.lineCount = String(count)
    const add = (edge: ContextEdge, text: string, label = text) => {
      const button = row.appendChild(document.createElement('button'))
      button.type = 'button'; button.dataset.contextEdge = edge
      button.className = edge === 'all' ? 'cm-collapsedLines' : 'code-context-expand'
      button.textContent = text; button.setAttribute('aria-label', label); button.title = label
      button.onclick = () => {
        const scroll = view.scrollSnapshot()
        const siblings = mergeViewSiblings(view)
        for (const current of siblings ? [siblings.a, siblings.b] : [view]) {
          current.dispatch({ effects: unfoldCode.of({ id: fold.id, edge }) })
        }
        view.dispatch({ effects: scroll })
        const next = view.dom.querySelector<HTMLElement>(`[data-fold-id="${fold.id}"] [data-context-edge="${edge}"]`)
        const focusTarget = next ?? view.contentDOM
        focusTarget.focus({ preventScroll: true })
      }
    }
    const step = Math.min(CONTEXT_LINES, count)
    if (fold.from > 0 || fold.to === view.state.doc.length) add('start', view.state.phrase('Expand $ lines below', step))
    add('all', view.state.phrase('$ unchanged lines', count), view.state.phrase('Expand all $ unchanged lines', count))
    if (fold.to < view.state.doc.length) add('end', view.state.phrase('Expand $ lines above', step))
    return row
  }
}

function collapsedCode(folds: readonly ContextFold[]) {
  const decoration = (fold: ContextFold) => Decoration.replace({ block: true, widget: new CollapsedCode(fold) }).range(fold.from, fold.to)
  return StateField.define({
    create: () => Decoration.set(folds.map(decoration)),
    update: (decorations, transaction) => {
      for (const effect of transaction.effects) if (effect.is(unfoldCode)) {
        const ranges: Range<Decoration>[] = []
        decorations.between(0, transaction.state.doc.length, (_from, _to, value) => {
          const widget = value.spec.widget as CollapsedCode
          const fold = widget.fold.id === effect.value.id ? expandContextFold(transaction.state.doc, widget.fold, effect.value.edge) : widget.fold
          if (fold) ranges.push(decoration(fold))
        })
        decorations = Decoration.set(ranges)
      }
      if (transaction.reconfigured) {
        // Refresh widget wording without restoring ranges the reader has unfolded.
        const localized: Range<Decoration>[] = []
        decorations.between(0, transaction.state.doc.length, (_from, _to, value) => {
          const widget = value.spec.widget
          if (widget instanceof CollapsedCode) localized.push(decoration(widget.fold))
        })
        decorations = Decoration.set(localized)
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
  const { t, locale } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const overviewHost = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const editors = useRef<EditorView | MergeView | null>(null)
  const localization = useRef(new Compartment())
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
    const folding = new Compartment()
    let overview: ReturnType<typeof codeOverview> | undefined
    const extensions = (evidence: Evidence, number = (line: number) => String(line + evidence.startLine - 1)) => [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      localization.current.of([]),
      folding.of([]),
      contextControls,
      EditorView.updateListener.of(update => {
        if (update.geometryChanged || update.viewportChanged || update.transactions.some(transaction => transaction.reconfigured)) overview?.update()
      }),
      lineNumbers({ formatNumber: number }),
      syntaxHighlighting(classHighlighter), language(evidence.path),
      keymap.of([{ key: 'F7', run: current => split || !unified ? goToNextChunk(current) : navigate.current(1) },
        { key: 'Shift-F7', run: current => split || !unified ? goToPreviousChunk(current) : navigate.current(-1) }]),
    ]
    const options = { highlightChanges: true, gutter: true, diffConfig: { scanLimit: 2000, timeout: 100 } }
    let editor: EditorView | MergeView
    if (split) {
      const merge = new MergeView({ parent: container.current,
        a: { doc: before.code!, extensions: extensions(before) },
        b: { doc: after.code!, extensions: extensions(after) }, ...options,
      })
      editor = merge
    } else if (unified) {
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
        extensions: [oldNumbers, ...extensions(after, line => {
          const number = unified.lines[line - 1]?.after
          return number === undefined ? '' : String(number + after.startLine - 1)
        }), EditorView.editorAttributes.of({ class: 'cm-unified-virtual cm-merge-b' }),
        EditorView.decorations.of(Decoration.set(decorations, true))],
      })
      editor = current
    } else {
      const current = new EditorView({ parent: container.current, doc: after.code!, extensions: [originalNumbers(before),
        ...extensions(after), unifiedMergeView({ original: before.code!, mergeControls: false, ...options })] })
      editor = current
    }
    const contexts = (editor instanceof MergeView ? [editor.a, editor.b] : [editor]).map(current => {
      const chunks = getChunks(current.state)
      const folds = unified ? unified.folds.map((fold, id) => ({ ...fold, id }))
        : contextFolds(current.state.doc, chunks!.chunks.map(chunk => chunks!.side === 'a'
          ? { from: chunk.fromA, to: chunk.toA } : { from: chunk.fromB, to: chunk.toB }))
      return { current, field: collapsedCode(folds) }
    })
    updateExpanded.current = full => {
      for (const { current, field } of contexts) current.dispatch({ effects: folding.reconfigure(full ? [] : field) })
    }
    updateExpanded.current(expandedRef.current)
    const applyExpanded = updateExpanded.current
    let currentExpanded = expandedRef.current
    updateExpanded.current = full => {
      if (full === currentExpanded) return
      currentExpanded = full
      applyExpanded(full)
    }
    editors.current = editor
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
    const ranges: OverviewRange[] = []
    if (unified) {
      for (let index = 0; index < unified.lines.length;) {
        const kind = unified.lines[index].kind
        if (!kind) { index++; continue }
        const start = index++
        while (index < unified.lines.length && unified.lines[index].kind === kind) index++
        ranges.push({ view: view.current, from: unified.doc.line(start + 1).from, to: unified.doc.line(index).to,
          kind: kind === 'removed' ? 'removed' : 'added' })
      }
    } else for (const chunk of chunks) {
      if (chunk.changes.some(change => change.toA > change.fromA)) ranges.push({ view: editor instanceof MergeView ? editor.a : view.current,
        from: editor instanceof MergeView ? chunk.fromA : chunk.fromB, to: editor instanceof MergeView ? chunk.toA : chunk.toB, kind: 'removed' })
      if (chunk.changes.some(change => change.toB > change.fromB)) ranges.push({ view: view.current, from: chunk.fromB, to: chunk.toB, kind: 'added' })
    }
    overview = codeOverview(overviewHost.current!, view.current,
      editor instanceof MergeView ? editor.dom : view.current.scrollDOM, ranges)
    setSummary(!split && unified ? { count: unified.changes.length, precise: unified.precise }
      : { count: chunks.length, precise: chunks.every(chunk => chunk.precise) })
    return () => { overview?.destroy(); view.current = null; editors.current = null; updateExpanded.current = () => {}; navigate.current = () => false; editor.destroy() }
  }, [before, after, split])
  useEffect(() => updateExpanded.current(expanded), [expanded])
  useEffect(() => {
    const editor = editors.current
    if (!editor) return
    // Reconfigure wording in place so language changes preserve reading position and expanded chunks.
    const localize = (current: EditorView, label: string) => {
      const scroll = current.scrollSnapshot()
      current.dispatch({ effects: localization.current.reconfigure([
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': t('{label}代码', { label }), 'aria-readonly': 'true' }),
        EditorState.phrases.of({
          '$ unchanged lines': t('{count} 行未修改', { count: '$' }),
          'Expand $ lines above': t('向上展开 {count} 行', { count: '$' }),
          'Expand $ lines below': t('向下展开 {count} 行', { count: '$' }),
          'Expand all $ unchanged lines': t('展开此段 {count} 行', { count: '$' }),
          'Snippet change overview': t('当前片段差异总览'),
          'Scroll position $%': t('阅读位置 {percent}%', { percent: '$' }),
          'Red: removed. Green: added. Click or drag to scroll the snippet.': t('红色为删除，绿色为新增；点击或拖动定位片段。'),
          'Revert this chunk': t('还原此处修改'), Accept: t('接受'), Reject: t('拒绝'),
          'Control character': t('控制字符'), close: t('关闭'),
          'Folded lines': t('已折叠行'), 'Unfolded lines': t('已展开行'), to: t('至'),
          'folded code': t('已折叠代码'), unfold: t('展开'), 'Fold line': t('折叠行'), 'Unfold line': t('展开行'),
        }),
      ]) })
      current.dispatch({ effects: scroll })
    }
    if (editor instanceof MergeView) { localize(editor.a, beforeLabel); localize(editor.b, afterLabel) }
    else localize(editor, afterLabel)
  }, [t, locale, beforeLabel, afterLabel, before, after, split, expanded])
  return <div className={`code-editor ${split ? 'is-split' : 'is-unified'}`}>
    <div className="code-editor-tools">
      <span role="status">{summary.count ? t('{count} 处差异', { count: summary.count }) : t('片段内容相同')}</span>
      <div className="tool-group"><button className="button icon-button" disabled={!summary.count} aria-label={t('上一处差异')} title={t('上一处差异 · Shift+F7')} onClick={() => navigate.current(-1)}><ArrowUp size={14} /></button>
        <button className="button icon-button" disabled={!summary.count} aria-label={t('下一处差异')} title={t('下一处差异 · F7')} onClick={() => navigate.current(1)}><ArrowDown size={14} /></button>
        <button className="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? '折叠未变' : '展开全文')}</button></div>
    </div>
    {!summary.precise && <p className="code-diff-note">{t('差异较大，部分区域仅标出整段变化。')}</p>}
    <div className="code-editor-labels">{split ? <><span>{t('{label} · 原行', { label: beforeLabel })}</span><span>{t('{label} · 新行', { label: afterLabel })}</span></> : <span>{t('原行 / 新行 · 删除 / 新增')}</span>}</div>
    <div className="code-editor-host"><div ref={container} className="code-editor-content" /><div ref={overviewHost} className="code-overview-host" /></div>
  </div>
}
