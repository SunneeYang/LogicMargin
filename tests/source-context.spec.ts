import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { structuralInput, structuralReview } from './fixtures/structural-review.ts'
import { validStructure } from '../src/structural-code-diff.ts'


const hash = (text: string) => createHash('sha256').update(text).digest('hex')
for (const language of ['go', 'ts', 'tsx']) test(`${language}: verified full context repairs truncated evidence without exposing source`, async ({ request, page }) => {
  const before = language === 'go'
    ? 'func Main(value int) bool {\n  label := "旧😀"\n  return len(label) < value'
    : language === 'tsx'
      ? 'export function Main({ value }: { value: number }) {\n  const label = "旧😀\\n";\n  return <b>{value < 3 ? label : "多"}</b>;'
      : 'export function Main(value: number) {\n  const label = "旧😀\\n";\n  return value < label.length;'
  const after = before.replace('旧😀', '新😁').replace(' < ', ' <= ')
  const review = structuralReview({ id: `full-context-${language}`, language, before, after, formattingOnly: false })
  const outsideMarker = 'OUTSIDE_SAVED_EVIDENCE_8319'
  const contents: string[] = []
  for (const [index, doc] of [review.baseline!, review].entries()) {
    const prefix = [language === 'go' ? 'package synthetic' : '// complete original file', ...Array(99).fill('// padding 😀')].join('\n') + '\n'
    const suffix = `\n}\n${language === 'go' ? 'var' : 'const'} ${outsideMarker} = ${index};\n`
    const raw = '\ufeff' + (prefix + doc.nodes[0].evidence[0].code + suffix).replaceAll('\n', '\r\n')
    contents.push(raw)
    doc.snapshot.files!.find(file => file.path === doc.nodes[0].evidence[0].path)!.sha256 = hash(raw)
    doc.snapshot.fingerprint = hash(JSON.stringify(doc.snapshot.files))
  }
  const created = await request.post('/api/review-sessions', { data: { review } })
  expect(created.ok(), await created.text()).toBe(true)
  const session = await created.json()
  const path = `/api/review-sessions/${session.id}`
  const input = structuralInput(session.review)
  const original = await (await request.get(path)).text()
  const missing = await request.post(`${path}/precompute/structure`, { data: input })
  expect(await missing.json()).toMatchObject({ mode: 'text', reason: 'invalid-syntax' })
  const caps = await (await request.get('/api/precompute')).json()
  expect(caps.sourceContextVersion).toBe(1)
  for (const [index, doc] of [review.baseline!, review].entries()) {
    const response = await request.post(`${path}/source-contexts`, { data: {
      snapshot: index === 0 ? { kind: 'baseline' } : { kind: 'round', round: 1 },
      fingerprint: doc.snapshot.fingerprint,
      sources: [{ path: doc.nodes[0].evidence[0].path, sha256: hash(contents[index]), content: contents[index] }],
    } })
    expect(response.ok(), await response.text()).toBe(true)
  }
  const response = await request.post(`${path}/precompute/structure`, { data: input })
  expect(response.ok(), await response.text()).toBe(true)
  const result = await response.json()
  expect(result.mode).toBe('structural')
  expect(await validStructure(result, caps.structureAlgorithm, caps.diffAlgorithm, input, before, after)).toBe(true)
  expect(result.highlights.before.length + result.highlights.after.length).toBeGreaterThan(0)
  expect(JSON.stringify(result)).not.toContain(outsideMarker)
  expect(await (await request.get(path)).text()).toBe(original)
  for (const view of ['', '?view=current']) {
    expect(await (await request.get(path + view)).text()).not.toContain(outsideMarker)
  }
  await page.goto(`/?session=${session.id}`)
  await expect(page.locator('.canvas')).toHaveAttribute('data-viewport-ready', 'true')
  await page.locator('.react-flow__node[data-id="sparse"] .node-comment-button').click()
  const panel = page.locator('[data-composer][data-state="open"]')
  await panel.getByRole('tab', { name: '代码 diff', exact: true }).click()
  await expect(panel.locator('.code-editor').first()).toHaveAttribute('data-diff-mode', 'structural')
  await expect(panel.locator('.cm-structural-highlight').first()).toBeAttached()
  await expect(panel.locator('.cm-editor')).toHaveCount(2)
})
