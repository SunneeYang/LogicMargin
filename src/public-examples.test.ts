import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseReview } from './model.ts'
import { sampleReview } from './sample.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

test('public examples bind only to authored repository rules with current digests', async () => {
  const pipeline = JSON.parse(read('public/reviews/task-pipeline.logic-margin.json'))
  const examples = [
    { review: sampleReview, id: 'demo-subscription-v1', path: 'examples/subscription.md', counts: [3, 24, 27] },
    { review: pipeline, id: 'demo-task-pipeline-v1', path: 'examples/task-pipeline.md', counts: [5, 42, 50] },
  ]
  for (const { review: input, id, path, counts } of examples) {
    const review = parseReview(input)
    assert.equal(review.id, id)
    assert.deepEqual([review.scenes.length, review.nodes.length, review.edges.length], counts)
    assert.deepEqual(review.comments, [])
    const content = read(path)
    assert.deepEqual(review.snapshot.files, [{ path, sha256: sha(content) }])
    assert.equal(review.snapshot.fingerprint, sha(JSON.stringify(review.snapshot.files)))
    for (const node of review.nodes) {
      assert.ok(node.evidence.length > 0)
      for (const evidence of node.evidence) {
        assert.equal(evidence.path, path)
        assert.equal(evidence.code, undefined)
        const lines = content.split('\n').slice(evidence.startLine - 1, evidence.endLine)
        assert.equal(lines.length, evidence.endLine - evidence.startLine + 1)
        assert.equal(sha(lines.join('\n')), evidence.digest)
        assert.ok(lines[0].includes(node.id))
      }
    }
    assert.doesNotMatch(JSON.stringify(review), /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|https?:\/\/)/)
  }
  const embedded = read('public/layout-prototype.html').match(/<script[^>]*id="review-data"[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(embedded)
  assert.deepEqual(JSON.parse(embedded[1]), pipeline)
})
