import type { EditorView } from '@codemirror/view'

export interface OverviewRange { view: EditorView; from: number; to: number; kind: 'removed' | 'added' }

export function overviewBands(marks: readonly { top: number; bottom: number; kind: 'removed' | 'added' }[], height: number, total: number) {
  const positions = marks.map(mark => {
    const top = Math.max(0, Math.min(height - 3, height * mark.top / total))
    return { top, bottom: Math.min(height, Math.max(top + 3, height * mark.bottom / total)) }
  })
  const ordered = positions.map((position, index) => ({ ...position, index })).sort((a, b) => a.top - b.top)
  const groups: { top: number; bottom: number; start: number; end: number; colors: number }[] = []
  for (let index = 0; index < ordered.length; index++) {
    let { top, bottom } = ordered[index]
    let start = index, colors = marks[ordered[index].index].kind === 'removed' ? 1 : 2
    while (groups.length && groups.at(-1)!.bottom >= top) {
      const previous = groups.pop()!
      start = previous.start; colors |= previous.colors
      top = Math.min(top, previous.top); bottom = Math.max(bottom, previous.bottom)
      const size = Math.min(height, Math.max(bottom - top, colors === 3 ? 6 : 3))
      top = Math.max(0, Math.min(top, height - size)); bottom = top + size
    }
    groups.push({ top, bottom, start, end: index + 1, colors })
  }
  for (const group of groups) for (let index = group.start; index < group.end; index++) {
    const original = ordered[index].index, middle = (group.top + group.bottom) / 2
    positions[original] = group.colors === 3
      ? marks[original].kind === 'removed' ? { top: group.top, bottom: middle } : { top: middle, bottom: group.bottom }
      : { top: group.top, bottom: group.bottom }
  }
  return positions
}

export function codeOverview(parent: HTMLElement, view: EditorView, scroll: HTMLElement, ranges: readonly OverviewRange[]) {
  const rail = parent.appendChild(document.createElement('div'))
  rail.className = 'code-overview'
  rail.hidden = !ranges.length
  const track = rail.appendChild(document.createElement('div'))
  track.className = 'code-overview-track'
  track.setAttribute('aria-hidden', 'true')
  const markers = ranges.map(range => {
    const marker = track.appendChild(document.createElement('span'))
    marker.className = `code-overview-mark is-${range.kind}`
    return marker
  })
  const viewport = track.appendChild(document.createElement('span'))
  viewport.className = 'code-overview-viewport'
  const input = rail.appendChild(document.createElement('input'))
  input.type = 'range'; input.min = '0'; input.max = '1000'; input.step = '1'
  input.value = '0'; input.disabled = true
  input.className = 'code-overview-input'
  let active = true
  let boundary: 'start' | 'end' | null = null
  const root = parent.closest<HTMLElement>('.code-editor')!
  root.dataset.codeOverview = String(ranges.length > 0)
  const releaseBoundary = () => { boundary = null }
  const inputEvents = ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const
  for (const event of inputEvents) root.addEventListener(event, releaseBoundary, { capture: true, passive: true })
  const update = () => {
    if (!active || !ranges.length) return
    view.requestMeasure({
      key: rail,
      read: () => {
        const top = scroll.scrollTop, height = scroll.clientHeight, total = Math.max(height, scroll.scrollHeight)
        const trackHeight = track.clientHeight
        if (!height || !total || !trackHeight) return null
        const scrollTop = scroll.getBoundingClientRect().top
        return { top, height, total, trackHeight, gutter: scroll.offsetWidth - scroll.clientWidth,
          bottom: scroll.offsetHeight - scroll.clientHeight, marks: ranges.map(range => {
          const from = Math.min(range.view.state.doc.length, range.from), to = Math.min(range.view.state.doc.length, range.to)
          const origin = range.view.documentTop - scrollTop + top
          const first = range.view.lineBlockAt(from), last = range.view.lineBlockAt(Math.max(from, to - 1))
          return { top: Math.max(0, origin + first.top), bottom: Math.min(total, origin + last.bottom), kind: range.kind }
        }) }
      },
      write: measured => {
        if (!active || !measured) return
        const { height, total, trackHeight, marks, gutter, bottom } = measured
        for (const [name, value] of [['--code-native-gutter', gutter], ['--code-overview-bottom', bottom]] as const) {
          if (root.style.getPropertyValue(name) !== `${value}px`) root.style.setProperty(name, `${value}px`)
        }
        // Follow spacer height corrections at the boundary until the next user interaction.
        const top = boundary === 'start' ? 0 : boundary === 'end' ? total - height : measured.top
        if (top !== measured.top) scroll.scrollTop = top
        const positions = overviewBands(marks, trackHeight, total)
        for (const [index, mark] of positions.entries()) {
          markers[index].style.top = `${mark.top}px`
          markers[index].style.height = `${mark.bottom - mark.top}px`
        }
        const thumbSize = Math.min(trackHeight, Math.max(16, trackHeight * height / total))
        viewport.style.top = `${total > height ? top / (total - height) * (trackHeight - thumbSize) : 0}px`
        viewport.style.height = `${thumbSize}px`
        rail.style.setProperty('--code-overview-thumb-size', `${thumbSize}px`)
        input.value = String(total > height ? Math.round(top / (total - height) * 1000) : 0)
        input.disabled = total <= height
        input.setAttribute('aria-label', view.state.phrase('Snippet change overview'))
        input.setAttribute('aria-valuetext', view.state.phrase('Scroll position $%', Math.round(Number(input.value) / 10)))
        input.title = view.state.phrase('Red: removed. Green: added. Click or drag to scroll the snippet.')
      },
    })
  }
  input.oninput = () => {
    const value = Number(input.value)
    boundary = value === 0 ? 'start' : value === 1000 ? 'end' : null
    scroll.scrollTop = value / 1000 * (scroll.scrollHeight - scroll.clientHeight)
    update()
  }
  input.onkeydown = event => {
    let top = scroll.scrollTop
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') top += view.defaultLineHeight * 3
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') top -= view.defaultLineHeight * 3
    else if (event.key === 'PageDown') top += scroll.clientHeight
    else if (event.key === 'PageUp') top -= scroll.clientHeight
    else if (event.key === 'Home' || event.key === 'End') {
      boundary = event.key === 'End' ? 'end' : 'start'
      top = boundary === 'end' ? scroll.scrollHeight : 0
    }
    else return
    event.preventDefault(); event.stopPropagation(); scroll.scrollTop = top; update()
  }
  const wheel = (event: WheelEvent) => {
    if (!event.deltaY) return
    const unit = event.deltaMode === 1 ? view.defaultLineHeight : event.deltaMode === 2 ? scroll.clientHeight : 1
    scroll.scrollTop += event.deltaY * unit
    event.preventDefault(); event.stopPropagation()
  }
  rail.addEventListener('wheel', wheel, { passive: false })
  scroll.addEventListener('scroll', update, { passive: true })
  const resize = new ResizeObserver(update)
  resize.observe(scroll)
  update()
  return { update, destroy() {
    active = false; resize.disconnect(); scroll.removeEventListener('scroll', update)
    delete root.dataset.codeOverview
    root.style.removeProperty('--code-native-gutter'); root.style.removeProperty('--code-overview-bottom')
    for (const event of inputEvents) root.removeEventListener(event, releaseBoundary, true)
    rail.removeEventListener('wheel', wheel); rail.remove()
  } }
}
