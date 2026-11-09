import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Compartment, EditorState, StateEffect, StateField, Text } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, lineNumbers } from '@codemirror/view'
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
import { buildUnifiedDiff, codeDiffConfig } from './unified-code-diff.ts'
import { precompute, sourceReference } from './precompute.ts'
import type { ComputedDiff, DiffContext } from './precompute.ts'
import { moveEvidence, unifiedStructureRanges, validHighlights } from './structural-code-diff.ts'
import type { InlineStructure, StructureResult } from './structural-code-diff.ts'
import { CONTEXT_LINES, contextFolds, expandContextFold } from './code-context.ts'
import type { ContextEdge, ContextFold } from './code-context.ts'
import { codeOverview } from './code-overview.ts'
import type { OverviewRange } from './code-overview.ts'
import { useI18n } from './i18n.ts'
import { ariaShortcut, formatShortcut } from './shortcuts.ts'
import type { ShortcutAction } from './shortcuts.ts'
import { useShortcutSettings } from './use-shortcuts.ts'

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

export default function CodeDiffEditor({ before, after, beforeLabel, afterLabel, split, precomputeContext, precomputedDiff, inlineStructure }: {
  before: Evidence; after: Evidence; beforeLabel: string; afterLabel: string; split: boolean; precomputeContext?: DiffContext
  precomputedDiff?: ComputedDiff; inlineStructure?: InlineStructure
}) {
  const { t, locale } = useI18n()
  const { bindings } = useShortcutSettings()
  function shortcutProps(action: ShortcutAction, label: string) {
    const binding = bindings[action]
    return { title: binding ? `${label} · ${formatShortcut(binding)}` : label, 'aria-keyshortcuts': binding ? ariaShortcut(binding) : undefined }
  }
  const root = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const overviewHost = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const editors = useRef<EditorView | MergeView | null>(null)
  const localization = useRef(new Compartment())
  const updateExpanded = useRef<(expanded: boolean) => void>(() => {})
  const navigate = useRef<(direction: number, target?: EditorView) => boolean>(() => false)
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const updateStructure = useRef<(highlights: InlineStructure | null, result?: StructureResult | null) => void>(() => {})
  const [openMoves, setOpenMoves] = useState<Set<string>>(() => new Set())
  const [structure, setStructure] = useState<{ requestKey: string; before: string; after: string; result: StructureResult | null } | null>(null)
  const [summary, setSummary] = useState({ count: 0, precise: true })
  const requestKey = precomputeContext && !precomputedDiff ? JSON.stringify({ ...precomputeContext, before: sourceReference(before), after: sourceReference(after) }) : ''
  const [computed, setComputed] = useState<{ requestKey: string; before: string; after: string; result: ComputedDiff | null } | null>(null)
  useEffect(() => {
    if (!requestKey) return
    const { sessionId, ...input } = JSON.parse(requestKey)
    const controller = new AbortController()
    void precompute.diff(sessionId, input, before.code!, after.code!, controller.signal).then(result => {
      if (!controller.signal.aborted) setComputed({ requestKey, before: before.code!, after: after.code!, result })
    }).catch(() => {})
    return () => controller.abort()
  }, [requestKey, before.code, after.code])
  useEffect(() => {
    if (!requestKey) return
    const { sessionId, ...input } = JSON.parse(requestKey)
    const controller = new AbortController()
    void precompute.structure(sessionId, input, before.code!, after.code!, controller.signal).then(result => {
      if (!controller.signal.aborted) setStructure({ requestKey, before: before.code!, after: after.code!, result })
    }).catch(() => { if (!controller.signal.aborted) setStructure({ requestKey, before: before.code!, after: after.code!, result: null }) })
    return () => controller.abort()
  }, [requestKey, before.code, after.code])
  const structureReady = structure?.requestKey === requestKey && structure.before === before.code && structure.after === after.code
  const structureResult = structureReady ? structure.result : null
  const activeStructure = inlineStructure && validHighlights(inlineStructure.highlights, before.code!, after.code!) ? inlineStructure
    : structureResult?.mode === 'structural' ? structureResult : null
  const associationOnly = precomputedDiff?.algorithm === 'association-text-v1'
  const reasons: Record<string, string> = {
    'invalid-syntax': '文本模式：片段不完整或语法无效，无法进行结构比较。',
    'unsupported-language': '文本模式：暂不支持此语言的结构比较。',
    'syntax-boundary': '文本模式：语法边界无法可靠匹配，保留完整差异。',
    budget: '文本模式：结构分析达到预算，保留完整差异。',
  }
  const structureExplanation = associationOnly ? '单侧关联仅显示片段增减，无两侧结构可比较。'
    : requestKey && !structureReady ? '正在分析结构…'
      : reasons[structureResult?.reason ?? ''] ?? '文本模式：当前材料未提供可用的结构分析结果。'
  const ready = !requestKey || computed?.requestKey === requestKey && computed.before === before.code && computed.after === after.code
  const result = precomputedDiff ?? (ready && requestKey ? computed?.result : null)
  const computedKey = result?.key ?? ''
  const unifiedCache = useRef<{ before: string; after: string; key: string; diff: ReturnType<typeof buildUnifiedDiff> } | null>(null)
  useEffect(() => {
    if (!container.current || !ready) return
    // Saved/inline comparisons use virtual lines from the start so late emphasis never replaces deletion widgets.
    const virtual = !split && (!!requestKey || !!precomputedDiff || !!inlineStructure || Math.max(before.endLine - before.startLine, after.endLine - after.startLine) >= 200)
    if (virtual && (unifiedCache.current?.before !== before.code || unifiedCache.current?.after !== after.code || unifiedCache.current?.key !== computedKey)) {
      unifiedCache.current = { before: before.code!, after: after.code!, key: computedKey, diff: buildUnifiedDiff(before.code!, after.code!, result) }
    }
    const unified = virtual ? unifiedCache.current!.diff : null
    const folding = new Compartment()
    const emphasis = new Compartment()
    let overview: ReturnType<typeof codeOverview> | undefined
    const extensions = (evidence: Evidence, number = (line: number) => String(line + evidence.startLine - 1)) => [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      localization.current.of([]),
      folding.of([]), emphasis.of([]),
      contextControls,
      EditorView.updateListener.of(update => {
        if (update.geometryChanged || update.viewportChanged || update.transactions.some(transaction => transaction.reconfigured)) overview?.update()
      }),
      lineNumbers({ formatNumber: number }),
      syntaxHighlighting(classHighlighter), language(evidence.path),
    ]
    const options = { highlightChanges: true, gutter: true, diffConfig: codeDiffConfig(result) }
    let editor: EditorView | MergeView
    if (split) {
      const merge = new MergeView({ parent: container.current,
        a: { doc: Text.of(before.code!.split('\n')), extensions: extensions(before) },
        b: { doc: Text.of(after.code!.split('\n')), extensions: extensions(after) }, ...options,
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
      const current = new EditorView({ parent: container.current, doc: Text.of(after.code!.split('\n')), extensions: [originalNumbers(before),
        ...extensions(after), unifiedMergeView({ original: Text.of(before.code!.split('\n')), mergeControls: false, ...options })] })
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
    const textNavigate = (direction: number, target?: EditorView) => {
      const current = target ?? view.current!
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
        const from = unified.doc.line(start + 1).from, to = Math.min(unified.doc.length, unified.doc.line(index).to + 1)
        if (!unified.marks.some(mark => mark.kind === kind && mark.from < to && mark.to > from)) continue
        ranges.push({ view: view.current, from, to: unified.doc.line(index).to,
          kind: kind === 'removed' ? 'removed' : 'added' })
      }
    } else for (const chunk of chunks) {
      if (chunk.changes.some(change => change.toA > change.fromA)) ranges.push({ view: editor instanceof MergeView ? editor.a : view.current,
        from: editor instanceof MergeView ? chunk.fromA : chunk.fromB, to: editor instanceof MergeView ? chunk.toA : chunk.toB, kind: 'removed' })
      if (chunk.changes.some(change => change.toB > change.fromB)) ranges.push({ view: view.current, from: chunk.fromB, to: chunk.toB, kind: 'added' })
    }
    const refreshOverview = (marks: OverviewRange[]) => {
      if (overview) overview.setRanges(marks)
      else overview = codeOverview(overviewHost.current!, view.current!,
        editor instanceof MergeView ? editor.dom : view.current!.scrollDOM, marks)
    }
    refreshOverview(ranges)
    navigate.current = textNavigate
    let appliedStructure: InlineStructure | null = null
    let appliedResult: StructureResult | null | undefined = null
    updateStructure.current = (structure, result) => {
      if (structure === appliedStructure && (!structure || result === appliedResult)) return
      appliedStructure = structure; appliedResult = result
      const current = view.current!
      const marks: OverviewRange[] = !structure ? [] : unified
        ? unifiedStructureRanges(unified, structure.highlights, before.code!, after.code!).map(range => ({ ...range, view: current }))
        : [
          ...structure.highlights.before.map(range => ({ ...range, view: editor instanceof MergeView ? editor.a : current, kind: 'removed' as const })),
          ...structure.highlights.after.map(range => ({ ...range, view: current, kind: 'added' as const })),
        ]
      const moves: OverviewRange[] = !structure ? [] : (result?.moves ?? []).flatMap(move => unified
        ? unifiedStructureRanges(unified, { before: [move.before], after: [move.after] }, before.code!, after.code!).map(range => ({ ...range, view: current }))
        : [{ ...move.before, view: editor instanceof MergeView ? editor.a : current, kind: 'removed' as const },
          { ...move.after, view: current, kind: 'added' as const }])
      for (const target of editor instanceof MergeView ? [editor.a, editor.b] : [editor]) {
        const decorations = marks.filter(mark => mark.view === target && mark.to > mark.from).map(mark => Decoration.mark({
          class: `cm-structure-highlight cm-structural-highlight cm-structural-${mark.kind}`,
        }).range(mark.from, mark.to))
        decorations.push(...moves.filter(mark => mark.view === target && mark.to > mark.from).map(mark => Decoration.mark({ class: 'cm-structural-move' }).range(mark.from, mark.to)))
        const scroll = target.scrollSnapshot()
        target.dispatch({ effects: emphasis.reconfigure([EditorView.decorations.of(Decoration.set(decorations, true))]) })
        target.dispatch({ effects: scroll })
      }
      refreshOverview(structure ? [...marks, ...moves] : ranges)
      const targets = [...marks, ...moves].sort((a, b) => a.from - b.from)
      let index = -1
      navigate.current = !structure ? textNavigate : direction => {
        if (!targets.length) return false
        index = index < 0 ? direction > 0 ? 0 : targets.length - 1 : (index + direction + targets.length) % targets.length
        const target = targets[index]
        target.view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'start' }) })
        target.view.focus(); return true
      }
    }
    setSummary(!split && unified ? { count: unified.changes.length, precise: unified.precise }
      : { count: chunks.length, precise: result?.precise ?? chunks.every(chunk => chunk.precise) })
    return () => { overview?.destroy(); view.current = null; editors.current = null; updateExpanded.current = () => {}; navigate.current = () => false; updateStructure.current = () => {}; editor.destroy() }
  }, [before.code, before.path, before.startLine, before.endLine, after.code, after.path, after.startLine, after.endLine, split, requestKey, ready, computedKey])
  useEffect(() => {
    updateStructure.current(activeStructure, structureResult)
  }, [activeStructure, structureResult, ready, computedKey, split])
  useEffect(() => {
    setOpenMoves(new Set())
  }, [requestKey, before.code, after.code])
  useEffect(() => updateExpanded.current(expanded), [expanded])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const handle = (event: Event) => {
      if (event.target !== element || !element.checkVisibility() || element.closest('[inert], [hidden], [aria-hidden="true"]') || !editors.current) return
      const action = (event as CustomEvent).detail
      if (action === 'toggleFullCode') setExpanded(current => !current)
      else if (action === 'nextDifference' || action === 'previousDifference') {
        const editor = editors.current
        const current = editor instanceof MergeView ? editor.a.hasFocus ? editor.a : editor.b : editor
        if (!navigate.current(action === 'nextDifference' ? 1 : -1, current)) return
      } else if (action !== 'toggleCodeLayout') return
      event.preventDefault()
    }
    element.addEventListener('logic-margin:code-shortcut', handle)
    return () => element.removeEventListener('logic-margin:code-shortcut', handle)
  }, [])
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
  }, [t, locale, beforeLabel, afterLabel, before.code, before.path, before.startLine, before.endLine, after.code, after.path, after.startLine, after.endLine, split, requestKey, ready, computedKey])
  return <div ref={root} data-diff-mode={activeStructure ? 'structural' : 'text'} className={`code-editor ${split ? 'is-split' : 'is-unified'}`}>
    <div className="code-editor-tools">
      <span role="status">{!ready ? t('正在加载代码对照…') : summary.count ? t('{count} 处差异', { count: summary.count }) : t('片段内容相同')}</span>
      <span className="code-control-label" role="status">{t(associationOnly ? '高亮：关联片段增减' : activeStructure ? '高亮：结构重点' : '高亮：文本差异')}</span>
      <div className="tool-group"><button className="button icon-button" {...shortcutProps('previousDifference', t('上一处差异'))} disabled={!ready || !summary.count} aria-label={t('上一处差异')} onClick={() => navigate.current(-1)}><ArrowUp size={14} /></button>
        <button className="button icon-button" {...shortcutProps('nextDifference', t('下一处差异'))} disabled={!ready || !summary.count} aria-label={t('下一处差异')} onClick={() => navigate.current(1)}><ArrowDown size={14} /></button>
        <button className="button" {...shortcutProps('toggleFullCode', t(expanded ? '折叠未变' : '展开全文'))} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? '折叠未变' : '展开全文')}</button></div>
    </div>
    {activeStructure?.formattingOnly && <p className="code-diff-note">{t('仅排版变化')}</p>}
    {!activeStructure && <p className="code-diff-note code-structure-reason" role="status">{t(structureExplanation)}</p>}
    {ready && !summary.precise && <p className="code-diff-note">{t('差异较大，部分区域仅标出整段变化。')}</p>}
    <div className="code-editor-labels">{split ? <><span>{t('{label} · 原行', { label: beforeLabel })}</span><span>{t('{label} · 新行', { label: afterLabel })}</span></> : <span>{t('原行 / 新行 · 删除 / 新增')}</span>}</div>
    <div className="code-editor-host"><div ref={container} className="code-editor-content" /><div ref={overviewHost} className="code-overview-host" /></div>
    {!!structureResult?.moves.length && <div className="code-moves" aria-label={t('移动代码')}>
      {structureResult.moves.map(move => {
        const old = moveEvidence(before, move.before, move.comparison.before.digest)
        const next = moveEvidence(after, move.after, move.comparison.after.digest)
        const open = openMoves.has(move.id)
        return <div className="code-move" data-move-id={move.id} key={move.id}>
          <div className="code-move-heading"><span>{t(move.modified ? '移动并修改' : '移动代码')} · <code>{move.name}</code></span>
            <button className="button code-move-compare" aria-expanded={open} onClick={() => setOpenMoves(current => {
              const updated = new Set(current); if (open) updated.delete(move.id); else updated.add(move.id); return updated
            })}>{t(open ? '收起对照' : '与原位置对照')}</button></div>
          {open && <div className="code-move-comparison">
            <p className="code-source-location"><code>{before.path}:{old.startLine}–{old.endLine} → {after.path}:{next.startLine}–{next.endLine}</code></p>
            <CodeDiffEditor before={old} after={next} beforeLabel={beforeLabel} afterLabel={afterLabel} split={split}
              precomputedDiff={move.comparison} inlineStructure={{ highlights: move.highlights, formattingOnly: false }} />
          </div>}
        </div>
      })}
    </div>}

  </div>
}
