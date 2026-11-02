import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newId } from './id.ts'
import { addComment, addReply } from './model.ts'
import { createFeedbackPackage } from './workspace.ts'
import { sampleReview } from './sample.ts'

test('comments, replies and feedback records keep unique UUIDs without the secure-context API', () => {
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
  try {
    const ids = Array.from({ length: 100 }, newId)
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    let review = addComment(sampleReview, [{ kind: 'review', id: sampleReview.id }], 'HTTP 评审意见')
    review = addReply(review, review.comments[0].id, 'HTTP 回复')
    const record = createFeedbackPackage(review)
    assert.equal(new Set([review.comments[0].id, review.comments[0].replies![0].id, record.id]).size, 3)
  } finally {
    if (original) Object.defineProperty(crypto, 'randomUUID', original)
    else Reflect.deleteProperty(crypto, 'randomUUID')
  }
})
