import { createHash } from 'node:crypto'
import { largeCodeReview } from './large-code-review.ts'

export function contextReview(lines: number) {
  const review = largeCodeReview()
  const original = Array.from({ length: lines }, (_, index) => `const item${index} = ${index};`)
  const changed = [...original]
  changed[lines - 30] = 'changed_later();'
  changed.splice(30, 1, 'changed_first();', 'inserted();', 'inserted_again();')
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  for (const [document, source] of [[review.baseline!, original], [review, changed]] as const) {
    const code = source.join('\n'), path = 'synthetic/context.ts', digest = hash(code)
    document.nodes = document.nodes.slice(0, 1)
    document.nodes[0].evidence = [{ path, symbol: 'context', code, digest, startLine: 101, endLine: 100 + source.length }]
    document.snapshot.files = [{ path, sha256: hash(`${'// preceding context\n'.repeat(100)}${code}`) }]
    document.snapshot.fingerprint = hash(JSON.stringify(document.snapshot.files))
  }
  return review
}
