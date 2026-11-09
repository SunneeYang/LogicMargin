import { useEffect, useMemo, useState } from 'react'
import { precompute } from './precompute.ts'
import type { ComputedLayout, LayoutInput } from './precompute.ts'
import type { layoutGraph } from './graph-layout.ts'

export function usePrecomputedLayout(sessionId: string | undefined, input: LayoutInput, fallback: () => Pick<ReturnType<typeof layoutGraph>, 'nodes' | 'edges'>) {
  const geometryKey = JSON.stringify([sessionId, input.nodes, input.edges, input.reference])
  const inputKey = JSON.stringify([geometryKey, input.sizes])
  const [computed, setComputed] = useState<{ geometryKey: string; inputKey: string; result: ComputedLayout | null } | null>(null)
  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    void precompute.layout(sessionId, input, controller.signal).then(result => {
      if (!controller.signal.aborted) setComputed({ geometryKey, inputKey, result })
    }).catch(() => {})
    return () => controller.abort()
    // Input identity includes only geometry and measured sizes, never review/UI wrappers.
  }, [sessionId, geometryKey, inputKey])
  const current = computed?.geometryKey === geometryKey ? computed : null
  const local = !sessionId || current?.result === null
  const result = current?.result
  const layout = useMemo(() => local ? fallback() : result ? {
    nodes: new Map(Object.entries(result.nodes)), edges: new Map(Object.entries(result.edges)), usesAuthoredPositions: result.usesAuthoredPositions,
  } : null, [local, inputKey, result?.key])
  return { layout, pending: !local && current?.inputKey !== inputKey }
}
