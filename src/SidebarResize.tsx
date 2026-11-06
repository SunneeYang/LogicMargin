import { useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'logic-margin:sidebar-widths'
const defaults = { left: 192, right: 420 }
type Widths = typeof defaults
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

export function useSidebarWidths(leftOpen: boolean, rightOpen: boolean) {
  const [preferred, setPreferred] = useState<Widths>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      return {
        left: Number.isFinite(saved?.left) ? clamp(saved.left, 180, 360) : defaults.left,
        right: Number.isFinite(saved?.right) ? Math.max(saved.right, 320) : defaults.right,
      }
    } catch { return defaults }
  })
  const [viewportWidth, setViewportWidth] = useState(innerWidth)
  useEffect(() => {
    const resize = () => setViewportWidth(innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred)) }
    catch { /* Width preferences must not interrupt a review. */ }
  }, [preferred])
  const leftMax = Math.max(180, Math.min(360, viewportWidth - (rightOpen ? 320 : 0) - 360))
  const left = clamp(preferred.left, 180, leftMax)
  const rightMax = Math.max(320, viewportWidth - (leftOpen ? left : 0))
  const right = clamp(preferred.right, 320, rightMax)
  const rightLayout = Math.min(right, Math.max(320, Math.min(960, rightMax - 360)))
  return {
    left, right, rightLayout, leftMax, rightMax, canvasWidth: viewportWidth - (leftOpen ? left : 0) - (rightOpen ? rightLayout : 0),
    change: (side: keyof Widths, width: number) => setPreferred(current => ({ ...current, [side]: width })),
  }
}

export default function SidebarResize({ side, width, max, onChange }: {
  side: keyof Widths
  width: number
  max: number
  onChange: (width: number) => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const min = side === 'left' ? 180 : 320
  const direction = side === 'left' ? 1 : -1
  return <div className={`sidebar-resize resize-${side}${dragging ? ' is-dragging' : ''}`}
    role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={side === 'left' ? '调整场景栏宽度' : '调整右侧栏宽度'}
    aria-controls={side === 'left' ? 'scene-navigation' : 'node-inspector'}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} 像素`}
    title="拖动调整宽度 · 方向键微调 · 双击恢复默认" data-keep-composer
    onDoubleClick={() => onChange(clamp(defaults[side], min, max))}
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, width }
      setDragging(true)
    }}
    onPointerMove={event => {
      if (drag.current) onChange(clamp(drag.current.width + (event.clientX - drag.current.x) * direction, min, max))
    }}
    onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      drag.current = null; setDragging(false)
    }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 16
      const next = event.key === 'ArrowLeft' ? width - step * direction : event.key === 'ArrowRight' ? width + step * direction
        : event.key === 'Home' ? min : event.key === 'End' ? max : undefined
      if (next !== undefined) { event.preventDefault(); onChange(clamp(next, min, max)) }
    }} />
}
