import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transformWithOxc } from 'vite'
import { EditorState, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as merge from '@codemirror/merge'
import * as focus from './graph-focus.ts'
import { sampleReview } from './sample.ts'
import { precompute } from './precompute.ts'
import { associationComparison } from './code-diff.ts'
import type { ComputedDiff, ComputedLayout, LayoutInput } from './precompute.ts'
import type { StructureResult } from './structural-code-diff.ts'

// Existing diff/layout unit cases must not seed the shared capability cache via real HTTP.
precompute.structure = async () => null

// Run component effects against real CodeMirror states without a DOM or a running service.
type Slot = { value?: any; deps?: readonly unknown[]; cleanup?: () => void; setter?: (value: any) => void }
function hookHost(component: (props: any) => any) {
  const slots: Slot[] = []
  let cursor = 0, dirty = false, props: any, tree: any
  const effects: (() => void)[] = []
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial: any) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      slot.setter ??= next => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true } }
      return [slot.value, slot.setter]
    },
    useRef(initial: any) { return hooks.useMemo(() => ({ current: initial }), []) },
    useMemo(create: () => any, deps: readonly unknown[]) {
      const i = cursor++
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: create(), deps }
      return slots[i].value
    },
    useCallback(callback: (...args: any[]) => any, deps: readonly unknown[]) { return hooks.useMemo(() => callback, deps) },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const i = cursor++
      const slot = slots[i] ??= {}
      if (!same(slot.deps, deps)) {
        slot.deps = deps
        effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined })
      }
    },
    useImperativeHandle(_ref: any, create: () => any, deps: readonly unknown[]) { hooks.useMemo(create, deps) },
  }
  const refs = (element: any) => {
    if (!element || typeof element !== 'object') return
    const ref = element.props?.ref
    if (ref && !ref.current) ref.current = { dataset: {}, removeAttribute() {}, querySelector() { return null }, addEventListener() {}, removeEventListener() {} }
    for (const child of [element.props?.children].flat(Infinity)) refs(child)
  }
  const flush = () => {
    Reflect.get(globalThis, '__precomputeTest').hooks = hooks
    for (let iteration = 0; dirty; iteration++) {
      assert.ok(iteration < 30, 'component effects must settle')
      dirty = false; cursor = 0; tree = component(props); refs(tree)
      effects.splice(0).forEach(effect => effect())
    }
    return tree
  }
  return { render(next: any) { props = next; dirty = true; return flush() }, flush,
    async settle() { for (let i = 0; i < 8; i++) { await new Promise<void>(resolve => setImmediate(resolve)); flush() } return tree },
    unmount() { slots.forEach(slot => slot.cleanup?.()) },
  }
}

const moduleUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const runtime = {
  hooks: {} as any, views: [] as FakeView[], split: new WeakMap<EditorState, { chunks: readonly merge.Chunk[]; side: 'a' | 'b' }>(),
  locale: 'zh-CN', localLayouts: 0,
}
Reflect.set(globalThis, '__precomputeTest', runtime)
const react = moduleUrl(`export const memo = fn => fn, forwardRef = fn => fn;
  ${['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useImperativeHandle'].map(name => `export const ${name} = (...args) => globalThis.__precomputeTest.hooks.${name}(...args);`).join('\n')}`)
const i18n = moduleUrl(`const t = (key, values) => values ? key.replace(/\{(\w+)\}/g, (_, k) => values[k]) : key;
  export const useI18n = () => ({t, locale: globalThis.__precomputeTest.locale});`)
class FakeView {
  state: EditorState
  dom = { querySelector() { return null } }
  scrollDOM = {}
  contentDOM = { focus() {} }
  destroyed = false
  constructor(options: any) { this.state = EditorState.create({ doc: options.doc, extensions: options.extensions }); runtime.views.push(this) }
  dispatch(transaction: any) { this.state = this.state.update(transaction).state }
  scrollSnapshot() { return StateEffect.appendConfig.of([]) }
  focus() {}
  destroy() { this.destroyed = true }
}
Object.setPrototypeOf(FakeView, EditorView)
class FakeMerge {
  a: FakeView
  b: FakeView
  dom = {}
  constructor(options: any) {
    this.a = new FakeView(options.a); this.b = new FakeView(options.b)
    const chunks = merge.Chunk.build(this.a.state.doc, this.b.state.doc, options.diffConfig)
    runtime.split.set(this.a.state, { chunks, side: 'a' }); runtime.split.set(this.b.state, { chunks, side: 'b' })
    for (const view of [this.a, this.b]) {
      const dispatch = view.dispatch.bind(view)
      view.dispatch = transaction => { const chunks = runtime.split.get(view.state)!; dispatch(transaction); runtime.split.set(view.state, chunks) }
    }
  }
  destroy() { this.a.destroy(); this.b.destroy() }
}
Object.assign(runtime, { FakeView, FakeMerge, merge, getChunks: (state: EditorState) => runtime.split.get(state) ?? merge.getChunks(state),
  focus, localLayout: () => { runtime.localLayouts++; throw new Error('local Dagre must not run on the Go path') } })
const mocks: Record<string, string> = {
  react, './i18n.ts': i18n,
  './use-shortcuts.ts': moduleUrl(`import {DEFAULT_SHORTCUTS} from ${JSON.stringify(new URL('./shortcuts.ts', import.meta.url).href)}; export const useShortcutSettings = () => ({bindings: DEFAULT_SHORTCUTS});`),
  '@codemirror/view': moduleUrl(`export * from ${JSON.stringify(import.meta.resolve('@codemirror/view'))}; export const EditorView = globalThis.__precomputeTest.FakeView;`),
  '@codemirror/merge': moduleUrl(`export * from ${JSON.stringify(import.meta.resolve('@codemirror/merge'))}; export const MergeView = globalThis.__precomputeTest.FakeMerge, getChunks = globalThis.__precomputeTest.getChunks, mergeViewSiblings = () => null;`),
  './code-overview.ts': moduleUrl('export const codeOverview = () => ({update(){}, setRanges(){}, destroy(){}});'),
  './graph-layout.ts': moduleUrl('export const layoutGraph = globalThis.__precomputeTest.localLayout;'),
  './graph-focus.ts': moduleUrl(`export const { availableScopeNodeIds, graphBounds, relatedNodeIds } = globalThis.__precomputeTest.focus;
    export const comparisonLayout = globalThis.__precomputeTest.localLayout;`),
  './GraphEdge.tsx': moduleUrl('export const relationColors = {}; export default function Edge(){}'),
  './GraphLegend.tsx': moduleUrl('export default function Legend(){}'),
  '@xyflow/react': moduleUrl(`import {useState} from ${JSON.stringify(react)};
    const noop = () => {}; export const useUpdateNodeInternals = () => noop;
    export const useNodesState = value => [...useState(value), noop], useEdgesState = useNodesState;
    export const Position = {}, SelectionMode = {}, MarkerType = {};
    export const ReactFlow = 'flow', Background = 'background', Controls = 'controls', ControlButton = 'control', Handle = 'handle';`),
}
async function componentModule(name: string) {
  const url = new URL(name, import.meta.url)
  const { code } = await transformWithOxc(await readFile(url, 'utf8'), url.pathname, { jsx: { runtime: 'automatic' } })
  return import(moduleUrl(code.replace(/from\s+["']([^"']+)["']/g, (_, path: string) => `from ${JSON.stringify(mocks[path] ?? (path.startsWith('.') ? new URL(path, url).href : import.meta.resolve(path)))}`) + `\n//# sourceURL=${url.href}?test`))
}
// The layout hook uses the same mocked React dispatcher as its real GraphCanvas caller.
mocks['./use-precomputed-layout.ts'] = moduleUrl((await transformWithOxc(await readFile(new URL('./use-precomputed-layout.ts', import.meta.url), 'utf8'), 'use-precomputed-layout.ts')).code
  .replace(/from\s+["']([^"']+)["']/g, (_, path: string) => `from ${JSON.stringify(mocks[path] ?? new URL(path, import.meta.url).href)}`))
const Editor = (await componentModule('./CodeDiffEditor.tsx')).default
const Canvas = (await componentModule('./GraphCanvas.tsx')).default
const find = (tree: any, predicate: (element: any) => boolean): any => {
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found }
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const ref = { path: 'saved.go', symbol: 'saved', digest: 'digest', startLine: 1, endLine: 3 }
const context = { sessionId: 'saved', beforeSnapshot: { kind: 'baseline' as const }, afterSnapshot: { kind: 'round' as const, round: 2 } }
function computed(before: string, after: string, key: string): ComputedDiff {
  return { schemaVersion: 1, algorithm: 'test-diff', coordinate: 'utf16', key, precise: true, language: 'go',
    before: { digest: 'digest', length: before.length }, after: { digest: 'digest', length: after.length },
    changes: [{ fromA: 0, toA: before.length, fromB: 0, toB: after.length }] }
}

test('single-sided references explain text-only highlighting without an unusable structural switch', () => {
  const comparison = associationComparison({ key: 'new-reference', ambiguous: false,
    after: { evidence: { ...ref, code: 'const added = true;' }, nodeIds: ['new'], nodeTitles: ['New'] } })!
  const host = hookHost(Editor)
  try {
    const tree = host.render({ before: comparison.before, after: comparison.after, beforeLabel: 'B', afterLabel: 'R1', split: false, precomputedDiff: comparison.diff })
    assert.equal(find(tree, item => item.type === 'button' && item.props.children === '结构重点'), undefined)
    assert.equal(find(tree, item => item.props?.className === 'code-diff-note code-structure-reason').props.children, '单侧关联仅显示片段增减，无两侧结构可比较。')
  } finally { host.unmount() }
})

test('an unexpected structure rejection settles to an explained text fallback', async () => {
  const originalDiff = precompute.diff, originalStructure = precompute.structure
  precompute.diff = async () => computed('old', 'new', 'fallback')
  precompute.structure = async () => { throw new Error('fixture rejection') }
  const host = hookHost(Editor)
  try {
    host.render({ before: { ...ref, code: 'old' }, after: { ...ref, code: 'new' }, beforeLabel: 'B', afterLabel: 'R1', split: false, precomputeContext: context })
    const tree = await host.settle()
    assert.equal(find(tree, item => item.type === 'button' && item.props.children === '结构重点'), undefined)
    assert.equal(find(tree, item => item.props?.className === 'code-diff-note code-structure-reason').props.children, '文本模式：当前材料未提供可用的结构分析结果。')
  } finally { host.unmount(); precompute.diff = originalDiff; precompute.structure = originalStructure }
})

test('all three editor modes wait for the backend and consume its override; comment and locale updates retain the editor', async () => {
  const original = precompute.diff
  try {
    for (const mode of ['split', 'short', 'long', 'short-carriage-return']) {
      const before = mode === 'long' ? Array.from({ length: 240 }, (_, i) => `line ${i}`).join('\n') : mode === 'short-carriage-return' ? 'header\rold\nfooter' : 'header\nold\nfooter'
      const after = before.replace(mode === 'long' ? 'line 120' : 'old', 'new')
      const pending = deferred<ComputedDiff | null>()
      let requests = 0
      precompute.diff = async () => { requests++; return pending.promise }
      const props = { before: { ...ref, code: before, endLine: mode === 'long' ? 240 : 3 }, after: { ...ref, code: after, endLine: mode === 'long' ? 240 : 3 },
        beforeLabel: 'B', afterLabel: 'R1', split: mode === 'split', precomputeContext: context }
      const host = hookHost(Editor), count = runtime.views.length
      host.render(props)
      assert.equal(runtime.views.length, count, `${mode}: no local diff editor while pending`)
      pending.resolve(computed(before, after, mode)); await host.settle()
      const view = runtime.views.at(-1)!
      if (mode !== 'split') assert.equal(view.state.doc.lines, before.split('\n').length * 2, 'coarse backend override displays both complete excerpts')
      else {
        const chunk = Reflect.get(runtime, 'getChunks')(view.state).chunks[0]
        assert.equal(chunk.fromB + chunk.changes[0].fromB, 0, 'backend range starts at header; local diff would start at old/new')
      }
      const editorCount = runtime.views.length
      const state = view.state
      host.render({ ...props, before: { ...props.before }, after: { ...props.after }, precomputeContext: structuredClone(context) })
      assert.equal(runtime.views.length, editorCount)
      assert.equal(view.state, state, 'polling wrappers must not even reconfigure editor state')
      runtime.locale = 'en-US'; host.render({ ...props, beforeLabel: 'Before' })
      runtime.locale = 'zh-CN'; host.render(props)
      assert.equal(runtime.views.length, editorCount)
      assert.equal(view.destroyed, false)
      assert.equal(requests, 1)
      host.unmount(); assert.equal(view.destroyed, true)
    }
  } finally { precompute.diff = original }
})

test('late diff responses cannot replace a newly selected snippet or round', async () => {
  const original = precompute.diff
  const old = deferred<ComputedDiff | null>(), next = deferred<ComputedDiff | null>()
  const signals: AbortSignal[] = []
  precompute.diff = async (_id, _input, _before, _after, signal) => { signals.push(signal!); return signals.length === 1 ? old.promise : next.promise }
  const host = hookHost(Editor)
  try {
    const first = { before: { ...ref, code: 'old' }, after: { ...ref, code: 'one' }, beforeLabel: 'B', afterLabel: 'R1', split: true, precomputeContext: context }
    const second = { ...first, after: { ...ref, path: 'other.go', code: 'two' }, precomputeContext: { ...context, afterSnapshot: { kind: 'round', round: 3 } } }
    host.render(first); host.render(second)
    assert.equal(signals[0].aborted, true)
    next.resolve(computed('old', 'two', 'new')); await host.settle()
    const count = runtime.views.length, view = runtime.views.at(-1)!
    old.resolve(computed('old', 'one', 'old')); await host.settle()
    assert.equal(runtime.views.length, count)
    assert.equal(view.state.doc.toString(), 'two')
  } finally { host.unmount(); precompute.diff = original }
})

test('repeated partial expansions survive comment polling and a language round trip', async () => {
  const original = precompute.diff, document = globalThis.document
  const before = Array.from({ length: 360 }, (_, i) => `line ${i}`).join('\n'), after = before.replace('line 200', 'changed')
  const from = before.indexOf('line 200')
  precompute.diff = async () => ({ ...computed(before, after, 'folded'), changes: [{ fromA: from, toA: from + 8, fromB: from, toB: from + 7 }] })
  const element = (): any => ({ children: [], dataset: {}, appendChild(child: any) { this.children.push(child); return child }, setAttribute() {} })
  Reflect.set(globalThis, 'document', { createElement: element })
  const host = hookHost(Editor)
  try {
    const props = { before: { ...ref, code: before, endLine: 360 }, after: { ...ref, code: after, endLine: 360 },
      beforeLabel: 'B', afterLabel: 'R1', split: false, precomputeContext: context }
    host.render(props); await host.settle()
    const view = runtime.views.at(-1)!
    const folds = () => {
      const widgets: any[] = []
      for (const decorations of view.state.facet(EditorView.decorations)) {
        if (typeof decorations !== 'function') decorations.between(0, view.state.doc.length, (_from, _to, decoration) => {
          if (decoration.spec.widget?.fold) widgets.push(decoration.spec.widget)
        })
      }
      return widgets
    }
    const first = folds()[0].fold.to
    for (let step = 0; step < 2; step++) {
      const widget = folds()[0]
      widget.toDOM(view).children.find((button: any) => button.dataset.contextEdge === 'end').onclick()
    }
    const expanded = folds().map(widget => ({ ...widget.fold }))
    assert.ok(expanded[0].to < first)
    const count = runtime.views.length
    host.render({ ...props, before: { ...props.before }, after: { ...props.after } })
    runtime.locale = 'en-US'; host.render({ ...props, afterLabel: 'Current' })
    runtime.locale = 'zh-CN'; host.render(props)
    assert.deepEqual(folds().map(widget => widget.fold), expanded)
    assert.equal(runtime.views.length, count)
    assert.equal(view.destroyed, false)
  } finally { host.unmount(); precompute.diff = original; globalThis.document = document }
})

function placed(input: LayoutInput, key: string): ComputedLayout {
  return { schemaVersion: 1, algorithm: 'layout-test', key, usesAuthoredPositions: false,
    nodes: Object.fromEntries(input.nodes.map(node => [node.id, { position: { x: 10, y: 20 }, width: 248, height: 160, ports: [] }])), edges: {} }
}

test('Go session canvas requests default then measured geometry, never local Dagre; stale graphs and sizes cannot overwrite it', async () => {
  const original = precompute.layout
  const raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame, resize = globalThis.ResizeObserver
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  const requests: { input: LayoutInput; signal: AbortSignal; result: ReturnType<typeof deferred<ComputedLayout | null>> }[] = []
  precompute.layout = async (_id, input, signal) => { const result = deferred<ComputedLayout | null>(); requests.push({ input, signal: signal!, result }); return result.promise }
  const review = { ...sampleReview, nodes: sampleReview.nodes.slice(0, 1), edges: [], comments: [] }
  const noop = () => {}
  const props = { review, comparisonReview: review, sceneId: review.nodes[0].sceneId, selection: [], setSelection: noop,
    changes: { added: [], removed: [], changed: [] }, mode: 'pan', nodeAppearance: 'plain', onNodeAppearanceChange: noop,
    onOpenComposer: noop, onOpenInspection: noop, onOpenThread: noop, precomputeSessionId: 'saved' }
  const host = hookHost(Canvas), local = runtime.localLayouts
  try {
    host.render(props)
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].input.sizes, [])
    assert.equal(requests[0].input.reference?.nodes[0].id, review.nodes[0].id)
    requests[0].result.resolve(placed(requests[0].input, 'default'))
    let tree = await host.settle()
    let flow = find(tree, element => element.type === 'flow')
    assert.equal(flow.props.nodes.length, 1)
    flow.props.onNodesChange([{ type: 'dimensions', id: review.nodes[0].id, dimensions: { width: 270, height: 190 } }])
    host.flush()
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1].input.sizes, [{ id: review.nodes[0].id, width: 270, height: 190 }])
    tree = host.render({ ...props, review: structuredClone(review), selection: [{ kind: 'node', id: review.nodes[0].id }], flowPulse: 2 })
    runtime.locale = 'en-US'; host.render(props); runtime.locale = 'zh-CN'
    assert.equal(requests.length, 2, 'comments, object wrappers, selection, pulse and locale do not request layouts')
    flow = find(tree, element => element.type === 'flow')
    flow.props.onNodesChange([{ type: 'dimensions', id: review.nodes[0].id, dimensions: { width: 280, height: 200 } }]); host.flush()
    assert.equal(requests[1].signal.aborted, true)
    requests[2].result.resolve(placed(requests[2].input, 'new-size')); await host.settle()
    requests[1].result.resolve({ ...placed(requests[1].input, 'stale-size'), nodes: { [review.nodes[0].id]: { position: { x: 999, y: 999 }, width: 270, height: 190, ports: [] } } })
    tree = await host.settle()
    assert.equal(find(tree, element => element.type === 'flow').props.nodes[0].position.x, 10)
    const other = { ...review, nodes: [{ ...review.nodes[0], id: 'other-node' }] }
    tree = host.render({ ...props, review: other, comparisonReview: undefined })
    assert.equal(find(tree, element => element.type === 'flow').props.nodes.length, 0, 'old IDs are cleared until new geometry arrives')
    requests.at(-1)!.result.resolve(placed(requests.at(-1)!.input, 'other'))
    tree = await host.settle()
    assert.equal(find(tree, element => element.type === 'flow').props.nodes[0].id, 'other-node')
    assert.equal(runtime.localLayouts, local)
  } finally {
    host.unmount(); precompute.layout = original
    globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel; globalThis.ResizeObserver = resize
  }
})

test('session canvas reaches capability and layout HTTP endpoints without evaluating browser Dagre', async () => {
  const fetcher = globalThis.fetch, raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame, resize = globalThis.ResizeObserver
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  const sent: { path: string; input?: LayoutInput }[] = []
  globalThis.fetch = async (url, options) => {
    const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined
    sent.push({ path, input })
    return new Response(JSON.stringify(path === '/api/precompute'
      ? { schemaVersion: 1, coordinate: 'utf16', diffAlgorithm: 'test-diff', layoutAlgorithm: 'layout-test' } : placed(input, `http-${sent.length}`)))
  }
  const review = { ...sampleReview, nodes: sampleReview.nodes.slice(0, 1), edges: [], comments: [] }, noop = () => {}
  const props = { review, sceneId: review.nodes[0].sceneId, selection: [], setSelection: noop, changes: { added: [], removed: [], changed: [] },
    mode: 'pan', nodeAppearance: 'plain', onNodeAppearanceChange: noop, onOpenComposer: noop, onOpenInspection: noop, onOpenThread: noop, precomputeSessionId: 'http-session' }
  const host = hookHost(Canvas), local = runtime.localLayouts
  try {
    host.render(props)
    let tree = await host.settle()
    const flow = find(tree, element => element.type === 'flow')
    assert.equal(flow.props.nodes.length, 1)
    flow.props.onNodesChange([{ type: 'dimensions', id: review.nodes[0].id, dimensions: { width: 260, height: 180 } }])
    host.flush(); tree = await host.settle()
    assert.deepEqual(sent.map(request => request.path), ['/api/precompute', '/api/review-sessions/http-session/precompute/layout', '/api/review-sessions/http-session/precompute/layout'])
    assert.deepEqual(sent[1].input?.sizes, [])
    assert.deepEqual(sent[2].input?.sizes, [{ id: review.nodes[0].id, width: 260, height: 180 }])
    assert.equal(find(tree, element => element.type === 'flow').props.nodes[0].id, review.nodes[0].id)
    assert.equal(runtime.localLayouts, local)
  } finally {
    host.unmount(); globalThis.fetch = fetcher
    globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel; globalThis.ResizeObserver = resize
  }
})

const structuralMarks = (view: FakeView) => {
  const marks: { from: number; to: number; class: string }[] = []
  for (const decorations of view.state.facet(EditorView.decorations)) if (typeof decorations !== 'function') {
    decorations.between(0, view.state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class?.includes('cm-structural-highlight')) marks.push({ from, to, class: decoration.spec.class })
    })
  }
  return marks
}
function structural(before: string, after: string): StructureResult {
  return { schemaVersion: 1, algorithm: 'structure-test', key: 'structure', coordinate: 'utf16', language: 'go',
    before: { digest: 'digest', length: before.length }, after: { digest: 'digest', length: after.length },
    mode: 'structural', formattingOnly: false, highlights: { before: [{ from: before.indexOf('old'), to: before.indexOf('old') + 1 }],
      after: [{ from: after.indexOf('new'), to: after.indexOf('new') + 1 }] }, scopes: [], moves: [] }
}

test('split, short and virtual editors automatically apply late structural marks in place', async () => {
  const originalDiff = precompute.diff, originalStructure = precompute.structure
  try {
    for (const mode of ['split', 'short', 'virtual']) {
      const before = mode === 'virtual' ? Array.from({ length: 300 }, (_, i) => i === 150 ? 'old' : `line ${i}`).join('\n') : 'header\nold\nfooter'
      const after = before.replace('old', 'new'), pending = deferred<StructureResult | null>()
      precompute.diff = async () => computed(before, after, mode)
      precompute.structure = async () => pending.promise
      const props = { before: { ...ref, code: before, endLine: mode === 'virtual' ? 300 : 3 },
        after: { ...ref, code: after, endLine: mode === 'virtual' ? 300 : 3 }, beforeLabel: 'B', afterLabel: 'R2', split: mode === 'split', precomputeContext: context }
      const host = hookHost(Editor)
      try {
        host.render(props); await host.settle()
        const view = runtime.views.at(-1)!, count = runtime.views.length
        assert.equal(structuralMarks(view).length, 0)
        view.dispatch({ selection: { anchor: 5, head: 8 } })
        const selection = view.state.selection.toJSON()
        Reflect.set(view.scrollDOM, 'scrollTop', 130)
        pending.resolve(structural(before, after))
        let tree = await host.settle()
        assert.equal(runtime.views.length, count, 'late structure keeps editor identity')
        assert.deepEqual(view.state.selection.toJSON(), selection)
        assert.equal(Reflect.get(view.scrollDOM, 'scrollTop'), 130)
        assert.equal(tree.props['data-diff-mode'], 'structural')
        assert.equal(find(tree, element => element.type === 'button' && ['结构重点', '文本差异'].includes(element.props.children)), undefined)
        assert.deepEqual(structuralMarks(view).map(mark => view.state.doc.sliceString(mark.from, mark.to)), mode === 'split' ? ['n'] : ['o', 'n'])
        const chunk = mode === 'split' ? Reflect.get(runtime, 'getChunks')(view.state).chunks[0] : null
        if (chunk) assert.equal(chunk.fromB + chunk.changes[0].fromB, 0, 'raw alignment still consumes the coarse text diff')
        runtime.locale = 'en-US'; host.render({ ...props, afterLabel: 'Current' }); runtime.locale = 'zh-CN'
        tree = host.render(props)
        assert.equal(runtime.views.length, count)
        assert.deepEqual(view.state.selection.toJSON(), selection)
        assert.equal(Reflect.get(view.scrollDOM, 'scrollTop'), 130)
        find(tree, element => element.type === 'button' && element.props['aria-label'] === '下一处差异').props.onClick()
        const target = mode === 'split' ? runtime.views.at(-2)! : view
        assert.equal(target.state.selection.main.head, structuralMarks(target)[0].from, 'navigation follows structural ranges, not the coarse raw text chunk')
        assert.equal(runtime.views.length, count)
      } finally { host.unmount() }
    }
  } finally { precompute.diff = originalDiff; precompute.structure = originalStructure }
})

test('automatic structure preserves repeated context expansions and language changes', async () => {
  const originalDiff = precompute.diff, originalStructure = precompute.structure, document = globalThis.document
  const before = Array.from({ length: 360 }, (_, i) => i === 200 ? 'old' : `line ${i}`).join('\n'), after = before.replace('old', 'new')
  const from = before.indexOf('old'), pending = deferred<StructureResult | null>()
  precompute.diff = async () => ({ ...computed(before, after, 'structure-folded'), changes: [{ fromA: from, toA: from + 3, fromB: from, toB: from + 3 }] })
  precompute.structure = async () => pending.promise
  const element = (): any => ({ children: [], dataset: {}, appendChild(child: any) { this.children.push(child); return child }, setAttribute() {} })
  Reflect.set(globalThis, 'document', { createElement: element })
  const host = hookHost(Editor)
  try {
    const props = { before: { ...ref, code: before, endLine: 360 }, after: { ...ref, code: after, endLine: 360 }, beforeLabel: 'B', afterLabel: 'R2', split: false, precomputeContext: context }
    host.render(props); await host.settle()
    const view = runtime.views.at(-1)!
    const folds = () => {
      const widgets: any[] = []
      for (const decorations of view.state.facet(EditorView.decorations)) if (typeof decorations !== 'function') {
        decorations.between(0, view.state.doc.length, (_from, _to, decoration) => { if (decoration.spec.widget?.fold) widgets.push(decoration.spec.widget) })
      }
      return widgets
    }
    for (let i = 0; i < 2; i++) folds()[0].toDOM(view).children.find((button: any) => button.dataset.contextEdge === 'end').onclick()
    const saved = folds().map(widget => ({ ...widget.fold })), count = runtime.views.length
    pending.resolve(structural(before, after)); const tree = await host.settle()
    assert.equal(tree.props['data-diff-mode'], 'structural')
    assert.deepEqual(folds().map(widget => widget.fold), saved)
    runtime.locale = 'en-US'; host.render(props); runtime.locale = 'zh-CN'; host.render(props)
    assert.deepEqual(folds().map(widget => widget.fold), saved); assert.equal(runtime.views.length, count)
  } finally { host.unmount(); precompute.diff = originalDiff; precompute.structure = originalStructure; globalThis.document = document }
})

test('moved code opens only saved slices with original line numbers and consumes precomputed comparison without HTTP', async () => {
  const originalDiff = precompute.diff, originalStructure = precompute.structure
  let calls = 0
  const before = 'prefix\nold Move😀 中文\nsuffix', after = 'prefix\n\nsuffix\nnew Move😀 中文'
  const oldFrom = before.indexOf('old'), newFrom = after.indexOf('new')
  const old = before.slice(oldFrom, before.indexOf('\nsuffix')), next = after.slice(newFrom)
  const pair = { id: 'moved', kind: 'function', name: 'Move😀 中文', before: { from: oldFrom, to: oldFrom + old.length }, after: { from: newFrom, to: after.length } }
  const result = structural(before, after)
  result.scopes = [pair]; result.moves = [{ ...pair, modified: true, highlights: { before: [{ from: 0, to: 3 }], after: [{ from: 0, to: 3 }] }, comparison: computed(old, next, 'fragment') }]
  precompute.diff = async () => { calls++; return computed(before, after, 'main') }
  precompute.structure = async () => { calls++; return result }
  const host = hookHost(Editor)
  try {
    const props = { before: { ...ref, code: before, startLine: 31, endLine: 33 }, after: { ...ref, code: after, startLine: 71, endLine: 74 }, beforeLabel: 'B', afterLabel: 'R2', split: false, precomputeContext: context }
    host.render(props); let tree = await host.settle()
    const main = runtime.views.at(-1)!
    find(tree, element => element.props?.className === 'button code-move-compare').props.onClick(); tree = host.flush()
    const local = find(tree, element => element.type === Editor)
    assert.equal(local.props.before.code, old); assert.equal(local.props.after.code, next)
    assert.equal(local.props.before.startLine, 32); assert.equal(local.props.after.startLine, 74)
    assert.equal(local.props.before.path, 'saved.go'); assert.equal(local.props.precomputeContext, undefined)
    assert.equal(local.props.precomputedDiff, result.moves[0].comparison)
    const child = hookHost(Editor)
    try {
      child.render(local.props); await child.settle()
      assert.equal(calls, 2, 'derived slices never request diff or structure')
      assert.ok(runtime.views.at(-1)!.state.doc.toString().includes(old))
      assert.ok(runtime.views.at(-1)!.state.doc.toString().includes(next))
    } finally { child.unmount() }
    tree = host.render(props)
    find(tree, element => element.props?.className === 'button code-move-compare').props.onClick(); host.flush()
    assert.equal(main.destroyed, false)
  } finally { host.unmount(); precompute.diff = originalDiff; precompute.structure = originalStructure }
})

test('unsupported, budget, invalid and old-service structures retain the complete text reader', async () => {
  const originalDiff = precompute.diff, originalStructure = precompute.structure
  try {
    for (const reason of [null, 'unsupported-language', 'invalid-syntax', 'budget', 'syntax-boundary'] as const) {
      const before = 'before old', after = 'after new', value = structural(before, after)
      precompute.diff = async () => computed(before, after, 'fallback')
      precompute.structure = async () => reason ? { ...value, mode: 'text', reason, formattingOnly: false, highlights: { before: [], after: [] } } : null
      const host = hookHost(Editor)
      try {
        host.render({ before: { ...ref, code: before }, after: { ...ref, code: after }, beforeLabel: 'B', afterLabel: 'R2', split: false, precomputeContext: context })
        const tree = await host.settle(), view = runtime.views.at(-1)!
        assert.equal(tree.props['data-diff-mode'], 'text')
        assert.equal(find(tree, element => element.type === 'button' && element.props.children === '结构重点'), undefined)
        assert.ok(view.state.doc.toString().includes(before)); assert.ok(view.state.doc.toString().includes(after))
        assert.equal(structuralMarks(view).length, 0)
      } finally { host.unmount() }
    }
  } finally { precompute.diff = originalDiff; precompute.structure = originalStructure }
})

test('a stale structure response cannot attach highlights or moves to the new snippet', async () => {
  const originalDiff = precompute.diff, originalStructure = precompute.structure
  const first = deferred<StructureResult | null>(), second = deferred<StructureResult | null>(), signals: AbortSignal[] = []
  precompute.diff = async (_id, _input, before, after) => computed(before, after, after)
  precompute.structure = async (_id, _input, _before, _after, signal) => { signals.push(signal!); return signals.length === 1 ? first.promise : second.promise }
  const host = hookHost(Editor)
  try {
    const props = { before: { ...ref, code: 'old' }, after: { ...ref, code: 'new' }, beforeLabel: 'B', afterLabel: 'R2', split: false, precomputeContext: context }
    host.render(props); await host.settle()
    const next = { ...props, after: { ...props.after, code: 'new snippet', path: 'other.go' } }
    host.render(next); await host.settle(); assert.equal(signals[0].aborted, true)
    const view = runtime.views.at(-1)!, count = runtime.views.length
    first.resolve(structural('old', 'new')); let tree = await host.settle()
    assert.equal(tree.props['data-diff-mode'], 'text')
    second.resolve(structural('old', 'new snippet')); tree = await host.settle()
    assert.equal(tree.props['data-diff-mode'], 'structural')
    assert.ok(structuralMarks(view).length > 0)
    assert.equal(view.destroyed, false); assert.equal(runtime.views.length, count)
  } finally { host.unmount(); precompute.diff = originalDiff; precompute.structure = originalStructure }
})
