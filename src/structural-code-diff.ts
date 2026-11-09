import { sha256 } from './structural-code-diff-sha256.ts'
import { validDiff } from './precompute.ts'
import type { ComputedDiff, DiffInput } from './precompute.ts'
import type { Evidence } from './types.ts'
import type { buildUnifiedDiff } from './unified-code-diff.ts'

export interface StructureRange { from: number; to: number }
export interface StructureHighlights { before: StructureRange[]; after: StructureRange[] }
export interface StructureScope { id: string; kind: string; name: string; before: StructureRange; after: StructureRange }
export interface StructureMove extends StructureScope { modified: boolean; highlights: StructureHighlights; comparison: ComputedDiff }
export interface StructureResult {
  schemaVersion: 1; algorithm: string; key: string; language: string; coordinate: 'utf16'
  before: { digest: string; length: number }; after: { digest: string; length: number }
  mode: 'structural' | 'text'
  reason?: 'unsupported-language' | 'invalid-syntax' | 'budget' | 'syntax-boundary'
  parsedAs?: { before: string; after: string }
  formattingOnly: boolean; highlights: StructureHighlights; scopes: StructureScope[]; moves: StructureMove[]
}
export type InlineStructure = Pick<StructureResult, 'highlights' | 'formattingOnly'>

export function utf16Boundary(text: string, at: number) {
  return !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]))
}
function validRange(range: StructureRange, text: string) {
  return !!range && Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) && range.from >= 0 &&
    range.to >= range.from && range.to <= text.length && utf16Boundary(text, range.from) && utf16Boundary(text, range.to)
}
export function validHighlights(value: StructureHighlights, before: string, after: string) {
  return !!value && ([['before', before], ['after', after]] as const).every(([side, text]) => {
    let end = 0
    return Array.isArray(value[side]) && value[side].every(range => {
      if (!validRange(range, text) || range.from < end) return false
      end = range.to; return true
    })
  })
}
async function digest(text: string) {
  const bytes = new TextEncoder().encode(text)
  if (globalThis.crypto?.subtle) {
    const result = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
  }
  return sha256(bytes)
}
export async function validStructure(value: unknown, algorithm: string, diffAlgorithm: string, input: DiffInput, before: string, after: string): Promise<boolean> {
  const item = value as StructureResult | null
  if (!item || item.schemaVersion !== 1 || item.algorithm !== algorithm || typeof item.key !== 'string' || !item.key ||
    item.coordinate !== 'utf16' || typeof item.language !== 'string' || typeof item.formattingOnly !== 'boolean' ||
    item.before?.digest !== input.before.digest || item.after?.digest !== input.after.digest ||
    item.before.length !== before.length || item.after.length !== after.length ||
    !validHighlights(item.highlights, before, after) || !Array.isArray(item.scopes) || !Array.isArray(item.moves) ||
    (item.parsedAs !== undefined && (!item.parsedAs || typeof item.parsedAs.before !== 'string' || typeof item.parsedAs.after !== 'string'))) return false
  if (item.mode === 'text') {
    if (!['unsupported-language', 'invalid-syntax', 'budget', 'syntax-boundary'].includes(item.reason ?? '') || item.formattingOnly ||
      item.highlights.before.length || item.highlights.after.length || item.scopes.length || item.moves.length) return false
  } else if (item.mode !== 'structural' || item.reason !== undefined || item.formattingOnly &&
    (item.highlights.before.length || item.highlights.after.length || item.moves.length)) return false
  const scopes = new Map<string, StructureScope>()
  for (const scope of item.scopes) {
    if (!scope || typeof scope.id !== 'string' || !scope.id || scopes.has(scope.id) ||
      typeof scope.kind !== 'string' || !scope.kind || typeof scope.name !== 'string' || !scope.name ||
      !validRange(scope.before, before) || !validRange(scope.after, after) ||
      scope.before.from === scope.before.to || scope.after.from === scope.after.to) return false
    scopes.set(scope.id, scope)
  }
  for (const side of ['before', 'after'] as const) {
    const ranges = item.scopes.map(scope => scope[side]).sort((a, b) => a.from - b.from)
    if (ranges.some((range, i) => i > 0 && range.from < ranges[i - 1].to)) return false
  }
  const ids = new Set<string>()
  for (const move of item.moves) {
    const scope = scopes.get(move?.id)
    if (!scope || ids.has(move.id) || move.kind !== scope.kind || move.name !== scope.name ||
      !['before', 'after'].every(side => {
        const key = side as 'before' | 'after'
        return move[key]?.from === scope[key].from && move[key]?.to === scope[key].to
      }) || typeof move.modified !== 'boolean' ||
      item.scopes.filter(other => other.kind === move.kind && other.name === move.name).length !== 1) return false
    ids.add(move.id)
    const a = before.slice(move.before.from, move.before.to), b = after.slice(move.after.from, move.after.to)
    if (!validHighlights(move.highlights, a, b) || move.comparison?.language !== item.language) return false
    const [aDigest, bDigest] = await Promise.all([digest(a), digest(b)])
    const fragment = { ...input, before: { ...input.before, digest: aDigest }, after: { ...input.after, digest: bDigest } }
    if (!validDiff(move.comparison, diffAlgorithm, fragment, a, b)) return false
  }
  const [aDigest, bDigest] = await Promise.all([digest(before), digest(after)])
  return aDigest === input.before.digest && bDigest === input.after.digest
}

// Slice only the saved evidence; line numbers never consult the current workspace.
export function moveEvidence(evidence: Evidence, range: StructureRange, digest: string): Evidence {
  const code = evidence.code!.slice(range.from, range.to)
  const startLine = evidence.startLine + evidence.code!.slice(0, range.from).split('\n').length - 1
  return { ...evidence, code, digest, startLine, endLine: startLine + code.split('\n').length - 1 }
}

export function unifiedStructureRanges(unified: ReturnType<typeof buildUnifiedDiff>, highlights: StructureHighlights, before: string, after: string) {
  const starts = (text: string) => { const result = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') result.push(i + 1); return result }
  const offsets = { before: starts(before), after: starts(after) }
  const result: (StructureRange & { kind: 'removed' | 'added' })[] = []
  unified.lines.forEach((line, index) => {
    for (const side of ['before', 'after'] as const) {
      const number = line[side]
      if (number === undefined) continue
      const sourceFrom = offsets[side][number - 1], targetFrom = unified.doc.line(index + 1).from
      for (const range of highlights[side]) {
        const from = Math.max(range.from, sourceFrom), to = Math.min(range.to, sourceFrom + line.text.length)
        if (to > from || range.from === range.to && range.from >= sourceFrom && range.from <= sourceFrom + line.text.length) {
          result.push({ from: targetFrom + from - sourceFrom, to: targetFrom + to - sourceFrom, kind: side === 'before' ? 'removed' : 'added' })
        }
      }
    }
  })
  return result
}
