import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { SessionStore } from './session-store.ts'
import { sampleReview } from '../src/sample.ts'
import { addComment, addReply } from '../src/model.ts'
import type { RevisionPublication, ReviewSession } from '../src/session-types.ts'
import type { ReviewDocument } from '../src/types.ts'

async function setup(t: { after: (run: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.env.CODEX_AGENT_TMP ?? tmpdir(), 'logic-margin-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new SessionStore(directory)
  const review = structuredClone(sampleReview)
  review.comments = []
  const session = await store.create(review)
  return { store, directory, session }
}
function commentBatch(state: ReviewSession, body = '此校验是否应在扣费之前？') {
  const next = addComment(state.review, [{ kind: 'node', id: state.review.nodes[0].id }], body)
  return { round: state.round, revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint, mutations: [{ kind: 'add-comment', comment: next.comments.at(-1)! }] }
}
function statusBatch(state: ReviewSession, status: 'open' | 'resolved' | 'needs-review') {
  return { round: state.round, revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint, expectedVersion: state.version,
    mutations: [{ kind: 'set-status', commentId: state.review.comments[0].id, from: state.review.comments[0].status, status, reviewedRevision: state.review.revision }] }
}
function replyBatch(state: ReviewSession, body = '已调整校验顺序') {
  const next = addReply(state.review, state.review.comments[0].id, body, 'agent')
  return { round: state.round, revision: state.review.revision, fingerprint: state.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-reply', commentId: state.review.comments[0].id, reply: next.comments[0].replies!.at(-1)! }] }
}
function revision(state: ReviewSession, review: ReviewDocument = structuredClone(state.review)) {
  const digest = createHash('sha256').update('verified fixture source\n').digest('hex')
  const files = [{ path: 'source.ts', sha256: digest }]
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  review.snapshot = { ...review.snapshot, files, fingerprint }
  review.nodes = review.nodes.map((node, index) => ({ ...node, evidence: index ? [] : [{ path: 'source.ts', symbol: 'fixture', startLine: 1, endLine: 1, digest }] }))
  const publication: RevisionPublication = { baseRound: state.round, summary: '根据本轮意见重新核对来源并发布',
    source: { algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files, fingerprint }, unchangedReason: '本轮补充说明，已核对业务流程未变' }
  return { expectedVersion: state.version, review, publication }
}

test('saving is separate from Finish; submissions, acknowledgement and opinions survive restart', async t => {
  const { store, directory, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  assert.equal(saved.phase, 'awaiting-review')
  assert.equal(saved.history.length, 0)
  const submitted = await store.finish(session.id, { expectedVersion: saved.version, kind: 'feedback', submissionId: 'finish-1' })
  assert.equal(submitted.phase, 'feedback-ready')
  assert.equal(submitted.history[0].review.comments.length, 1)
  await assert.rejects(store.mutate(session.id, statusBatch(submitted, 'resolved')), /尚未发布/)
  const acknowledged = await store.acknowledge(session.id, { submissionId: 'finish-1' })
  assert.equal(acknowledged.phase, 'agent-working')
  assert.deepEqual(await store.acknowledge(session.id, { submissionId: 'finish-1' }), acknowledged)
  assert.deepEqual(await new SessionStore(directory).get(session.id), acknowledged)
  assert.deepEqual(await store.finish(session.id, { expectedVersion: saved.version, kind: 'feedback', submissionId: 'finish-1' }), acknowledged)
})

test('saved source code stays version-bound through comments, publication, history and restart', async t => {
  const { store, directory } = await setup(t)
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  function sourceReview(code: string, revision: string) {
    const review = structuredClone(sampleReview)
    review.comments = []
    review.revision = revision
    const files = [{ path: 'logic.ts', sha256: sha256(`${code}\n`) }]
    review.snapshot = { ...review.snapshot, files, fingerprint: sha256(JSON.stringify(files)) }
    review.nodes.forEach(node => { node.evidence = [] })
    review.nodes[0].evidence = [{ path: 'logic.ts', symbol: 'charge', startLine: 1, endLine: 1, digest: sha256(code), code }]
    return review
  }
  const baseline = sourceReview('chargeBeforeSuccess()', 'B')
  const review = { ...sourceReview('chargeAfterSuccess()', 'R1'), baseline }
  const first = await store.create(review)
  const corrupted = structuredClone(review)
  corrupted.nodes[0].evidence[0].code = 'forged()'
  await assert.rejects(store.create(corrupted), /片段与摘要不一致/)
  const badBaseline = structuredClone(review)
  badBaseline.baseline.nodes[0].evidence[0].code = 'forged()'
  await assert.rejects(store.create(badBaseline), /片段与摘要不一致/)
  const badManifest = structuredClone(review)
  badManifest.snapshot.files![0].sha256 = '0'.repeat(64)
  await assert.rejects(store.create(badManifest), /来源清单与快照指纹不一致/)
  const commented = await store.mutate(first.id, { ...commentBatch(first), review: corrupted })
  assert.equal(commented.review.nodes[0].evidence[0].code, 'chargeAfterSuccess()')
  const submitted = await store.finish(first.id, { expectedVersion: commented.version, kind: 'feedback' })
  const next = sourceReview('chargeOnlyOnce()', 'R2')
  const publication: RevisionPublication = { baseRound: 1, summary: '增加幂等校验', unchangedReason: '补充同一流程步骤的实现', source: {
    algorithm: 'sha256-path-content-v1', checkedAt: new Date().toISOString(), files: next.snapshot.files!, fingerprint: next.snapshot.fingerprint,
  } }
  const published = await store.revise(first.id, { expectedVersion: submitted.version, review: next, publication })
  assert.equal(published.review.nodes[0].evidence[0].code, 'chargeOnlyOnce()')
  assert.equal((await store.getSnapshot(first.id, 1)).review.nodes[0].evidence[0].code, 'chargeAfterSuccess()')
  assert.equal((await store.getBaseline(first.id)).review.nodes[0].evidence[0].code, 'chargeBeforeSuccess()')
  assert.equal(published.history[0].review.nodes[0].evidence[0].code, 'chargeAfterSuccess()')
  assert.deepEqual(await new SessionStore(directory).get(first.id), published)
  const corruptedHistory = structuredClone(published)
  corruptedHistory.history[0].review.nodes[0].evidence[0].code = 'forged()'
  await writeFile(join(directory, `${first.id}.json`), JSON.stringify(corruptedHistory))
  await assert.rejects(new SessionStore(directory).get(first.id), /片段与摘要不一致/)
})

test('fixed baseline B is present in R1, survives R2 and records, and is read separately from current views', async t => {
  const { store, directory } = await setup(t)
  const baseline = { ...structuredClone(sampleReview), revision: 'baseline-code', comments: [] }
  const review = { ...structuredClone(sampleReview), comments: [], baseline }
  const first = await store.create(review)
  assert.equal(first.round, 1)
  assert.deepEqual(first.review.baseline, baseline)
  assert.deepEqual(first.snapshots[0].review.baseline, baseline)
  const current = await store.get(first.id, 'current')
  assert.equal(current.review.baseline, undefined)
  assert.equal(current.baseline?.revision, baseline.revision)
  assert.equal('files' in current.baseline!.snapshot, false)
  const read = await store.getBaseline(first.id)
  read.review.nodes[0].title = 'caller mutation'
  assert.deepEqual((await store.getBaseline(first.id)).review, baseline)
  const saved = await store.mutate(first.id, commentBatch(first))
  const submitted = await store.finish(first.id, { expectedVersion: saved.version, kind: 'feedback' })
  assert.deepEqual(submitted.history[0].review.baseline, baseline)
  const nextReview = structuredClone(first.review)
  delete nextReview.baseline
  nextReview.revision = 'second-review'
  const two = await store.revise(first.id, revision(submitted, nextReview))
  assert.equal(two.round, 2)
  assert.deepEqual(two.review.baseline, baseline)
  assert.deepEqual(two.snapshots[1].review.baseline, baseline)
  assert.deepEqual((await new SessionStore(directory).get(first.id)).review.baseline, baseline)
  const replacement = revision(two)
  replacement.review.baseline!.revision = 'other-code'
  await assert.rejects(store.revise(first.id, replacement), { status: 409 })
  assert.deepEqual((await store.get(first.id)).review.baseline, baseline)
  const inconsistent = structuredClone(two)
  inconsistent.snapshots[0].review.baseline!.revision = 'changed-original'
  await writeFile(join(directory, `${first.id}.json`), JSON.stringify(inconsistent))
  await assert.rejects(new SessionStore(directory).get(first.id), /固定基线不一致/)
})

test('legacy baseline attachment is atomic, does not advance the review round and rejects conflicting writers', async t => {
  const { store, directory, session } = await setup(t)
  await assert.rejects(store.getBaseline(session.id), { status: 404 })
  assert.equal((await store.get(session.id, 'current')).baseline, undefined)
  const baseline = { ...structuredClone(session.review), revision: 'baseline-code', comments: [] }
  await assert.rejects(store.attachBaseline(session.id, { expectedVersion: session.version + 1, baseline }), { status: 409 })
  const implicit = revision(session)
  implicit.review.baseline = baseline
  await assert.rejects(store.revise(session.id, implicit), /请先补录固定基线/)
  const alternatives = [baseline, { ...baseline, revision: 'another-baseline' }]
  const results = await Promise.allSettled(alternatives.map(baseline => store.attachBaseline(session.id, { expectedVersion: session.version, baseline })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  const attached = await store.get(session.id)
  assert.equal(attached.version, session.version + 1)
  assert.equal(attached.round, session.round)
  assert.deepEqual(attached.history, session.history)
  assert.deepEqual(attached.snapshots, session.snapshots)
  assert.deepEqual(await store.attachBaseline(session.id, { expectedVersion: session.version, baseline: attached.review.baseline }), attached)
  await assert.rejects(store.attachBaseline(session.id, { expectedVersion: attached.version, baseline: { ...baseline, id: 'other-review' } }), /相同评审 ID/)
  const approved = await store.finish(session.id, { expectedVersion: attached.version, kind: 'approval' })
  await store.cleanup(session.id, { expectedVersion: approved.version, mode: 'archive' })
  assert.deepEqual((await store.getArchive(session.id)).review.baseline, attached.review.baseline)
  const restored = await new SessionStore(directory).restore(session.id, { expectedVersion: approved.version })
  assert.deepEqual(restored.review.baseline, attached.review.baseline)
})

test('baseline-first reviews accept redesign requests on B and retain those sources after publishing R1', async t => {
  const { store, directory, session } = await setup(t)
  const baseline = structuredClone(session.review)
  const original = { ...structuredClone(baseline), baseline }
  await assert.rejects(store.create(session.review, undefined, { baselineReview: true }), /必须提供固定基线/)
  const different = structuredClone(original)
  different.nodes[0].summary += ' already changed'
  await assert.rejects(store.create(different, undefined, { baselineReview: true }), /初始图必须/)
  const first = await store.create(original, undefined, { baselineReview: true })
  assert.equal(first.baselineReview, true)
  assert.equal((await store.get(first.id, 'current')).baselineReview, true)
  await assert.rejects(store.finish(first.id, { expectedVersion: first.version, kind: 'approval' }), /基线 B 用于提出改造要求/)
  const target = { kind: 'node' as const, id: baseline.nodes[0].id }
  const comment = addComment(first.review, [target], '请重构这个旧步骤', 'baseline').comments[0]
  const batch = { round: first.round, revision: first.review.revision, fingerprint: first.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-comment', comment }] }
  const saved = await store.mutate(first.id, batch)
  assert.equal(saved.review.comments[0].basis, 'baseline')
  assert.equal(saved.review.comments[0].originRound, 1)
  await assert.rejects(store.mutate(first.id, { ...batch, mutations: [{ kind: 'add-comment', comment: { ...comment, basis: undefined } }] }), { status: 409 })
  const submitted = await store.finish(first.id, { expectedVersion: saved.version, kind: 'feedback' })
  assert.equal(submitted.history[0].review.comments[0].basis, 'baseline')
  const next = structuredClone(first.review)
  next.revision = 'implementation-r1'
  next.nodes = next.nodes.slice(1)
  next.edges = next.edges.filter(edge => edge.source !== target.id && edge.target !== target.id)
  const one = await store.revise(first.id, revision(submitted, next))
  assert.equal(one.baselineReview, true)
  assert.equal(one.round, 2)
  assert.equal(one.review.comments[0].basis, 'baseline')
  assert.deepEqual(one.review.comments[0].targets, [target])
  assert.equal(one.review.comments[0].status, 'needs-review')
  assert.deepEqual(one.review.baseline, baseline)
  assert.deepEqual((await new SessionStore(directory).get(first.id)).review, one.review)
})

test('concurrent appends merge, retry does not duplicate, conflicts and batches are atomic', async t => {
  const { store, session } = await setup(t)
  const first = commentBatch(session, '第一条')
  const second = commentBatch(session, '第二条')
  await Promise.all([store.mutate(session.id, first), store.mutate(session.id, second)])
  const merged = await store.get(session.id)
  assert.equal(merged.review.comments.length, 2)
  assert.deepEqual(await store.mutate(session.id, first), merged)
  const conflict = structuredClone(first)
  conflict.mutations[0].comment.body = '篡改相同标识'
  await assert.rejects(store.mutate(session.id, conflict), /冲突/)
  const atomic = commentBatch(merged, '不应留下部分批次')
  await assert.rejects(store.mutate(session.id, { ...atomic, mutations: [...atomic.mutations, { kind: 'unknown' }] }), /不支持/)
  assert.deepEqual(await store.get(session.id), merged)
})

test('agent replies require human recheck; unseen replies prevent stale resolution and approval', async t => {
  const { store, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const replyAndResolve = replyBatch(saved)
  await assert.rejects(store.mutate(session.id, { ...replyAndResolve, expectedVersion: saved.version,
    mutations: [...replyAndResolve.mutations, { ...statusBatch(saved, 'resolved').mutations[0], from: 'needs-review' }] }), /尚未发布/)
  assert.deepEqual(await store.get(session.id), saved)
  const firstReply = await store.mutate(session.id, replyBatch(saved))
  assert.equal(firstReply.review.comments[0].status, 'needs-review')
  assert.equal(firstReply.phase, 'agent-working')
  const attemptedResolution = statusBatch(firstReply, 'resolved')
  const secondReply = await store.mutate(session.id, replyBatch(firstReply, '补充说明'))
  await assert.rejects(store.mutate(session.id, attemptedResolution), /最新回复/)
  await assert.rejects(store.finish(session.id, { kind: 'approval', expectedVersion: firstReply.version }), /已有更新/)
  await assert.rejects(store.finish(session.id, { kind: 'approval', expectedVersion: secondReply.version }), /不能确认/)
  await assert.rejects(store.mutate(session.id, statusBatch(secondReply, 'resolved')), /尚未发布/)
  const published = await store.revise(session.id, revision(secondReply))
  const resolved = await store.mutate(session.id, statusBatch(published, 'resolved'))
  assert.equal(resolved.review.comments[0].reviewedRound, 2)
  const approved = await store.finish(session.id, { kind: 'approval', expectedVersion: resolved.version })
  assert.equal(approved.phase, 'approved')
  const restored = await store.mutate(session.id, statusBatch(approved, 'open'))
  assert.equal(restored.phase, 'awaiting-review')
  assert.equal(restored.review.comments[0].replies?.length, 2)
})

test('publishing a new round preserves all opinions and immutable submissions', async t => {
  const { store, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const finished = await store.finish(session.id, { kind: 'feedback', expectedVersion: saved.version })
  const before = structuredClone(finished.history)
  const incoming = structuredClone(session.review)
  incoming.revision = 'revision-two'
  const next = await store.revise(session.id, revision(finished, incoming))
  assert.equal(next.round, 2)
  assert.equal(next.phase, 'awaiting-review')
  assert.equal(next.snapshots.length, 2)
  assert.equal(next.review.comments[0].status, 'needs-review')
  assert.equal(next.review.comments[0].revision, session.review.revision)
  assert.equal(next.review.comments[0].originRound, 1)
  assert.deepEqual(next.review.comments[0].targets, saved.review.comments[0].targets)
  assert.deepEqual(next.history, before)
  await assert.rejects(store.acknowledge(session.id, { submissionId: finished.history[0].id }), /已结束的轮次/)
  await assert.rejects(store.mutate(session.id, commentBatch(session)), /流程已更新/)
  const foreign = structuredClone(incoming); foreign.id = 'other-document'
  await assert.rejects(store.revise(session.id, { expectedVersion: next.version, review: foreign }), /相同评审/)
})

test('publication requires consistent verified sources and an explicit reason for unchanged logic', async t => {
  const { store, session } = await setup(t)
  await assert.rejects(store.revise(session.id, { expectedVersion: session.version, review: session.review }), /缺少来源核验/)
  const noReason = revision(session)
  delete noReason.publication.unchangedReason
  await assert.rejects(store.revise(session.id, noReason), /没有逻辑变化/)
  const wrongHash = revision(session)
  wrongHash.publication.source.fingerprint = '0'.repeat(64)
  await assert.rejects(store.revise(session.id, wrongHash), /指纹不一致/)
  const noManifest = revision(session)
  delete noManifest.review.snapshot.files
  await assert.rejects(store.revise(session.id, noManifest), /来源文件清单/)
  const otherFile = revision(session)
  otherFile.review.nodes[0].evidence[0].path = 'outside.ts'
  await assert.rejects(store.revise(session.id, otherFile), /流程依据/)
  const badDigest = revision(session)
  badDigest.review.nodes[0].evidence[0].digest = 'old-digest'
  await assert.rejects(store.revise(session.id, badDigest), /流程依据/)
  const staleBase = revision(session)
  staleBase.publication.baseRound = 2
  await assert.rejects(store.revise(session.id, staleBase), /发布基线/)
  assert.deepEqual(await store.get(session.id), session)
  const changed = revision(session)
  changed.review.nodes[0].summary += ' 新增业务条件'
  delete changed.publication.unchangedReason
  assert.equal((await store.revise(session.id, changed)).round, 2)
})

test('final replies and graph publish atomically; removed anchors and frozen history remain intact', async t => {
  const { store, directory, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const submitted = await store.finish(session.id, { kind: 'feedback', expectedVersion: saved.version })
  const original = structuredClone(submitted.review.comments[0])
  const request = revision(submitted)
  const removed = request.review.nodes[0].id
  request.review.nodes = request.review.nodes.filter(node => node.id !== removed)
  request.review.edges = request.review.edges.filter(edge => edge.source !== removed && edge.target !== removed)
  const replies = [{ commentId: original.id, body: '校验已移至结算阶段，请复核新版' }]
  const path = join(directory, `${session.id}.json`)
  const before = await readFile(path, 'utf8')
  await assert.rejects(store.revise(session.id, { ...request, replies: [...replies, { commentId: 'missing', body: '不会单独留下第一条回复' }] }), /找不到此批注/)
  assert.equal(await readFile(path, 'utf8'), before)
  const next = await store.revise(session.id, { ...request, replies })
  assert.equal(next.round, 2)
  assert.equal(next.phase, 'awaiting-review')
  assert.equal(next.review.comments[0].body, original.body)
  assert.deepEqual(next.review.comments[0].targets, original.targets)
  assert.equal(next.review.comments[0].originRound, 1)
  assert.equal(next.review.comments[0].revision, original.revision)
  assert.equal(next.review.comments[0].replies?.[0].round, 2)
  assert.equal(next.review.comments[0].replies?.[0].revision, next.review.revision)
  assert.equal(next.review.comments[0].status, 'needs-review')
  assert.deepEqual(next.snapshots[0], submitted.snapshots[0])
  assert.deepEqual(next.history, submitted.history)
  assert.deepEqual(next.snapshots[1].publication, request.publication)
  assert.deepEqual(next.snapshots[1].review, next.review)
  assert.deepEqual(await new SessionStore(directory).get(session.id), next)
})

test('round metadata remains precise when source revision is reused across publications', async t => {
  const { store, session } = await setup(t)
  const first = await store.mutate(session.id, commentBatch(session))
  const two = await store.revise(session.id, revision(first))
  const humanChecked = await store.mutate(session.id, statusBatch(two, 'resolved'))
  const second = await store.mutate(session.id, commentBatch(humanChecked, '第二轮的新意见'))
  const three = await store.revise(session.id, revision(second))
  assert.equal(three.review.revision, session.review.revision)
  assert.deepEqual(three.review.comments.map(comment => comment.originRound), [1, 2])
  assert.equal(three.review.comments[0].reviewedRound, 2)
  const saved = await store.mutate(session.id, { ...commentBatch(three), round: 3 })
  assert.equal(saved.review.comments.at(-1)?.originRound, 3)
  await assert.rejects(store.mutate(session.id, { ...commentBatch(saved), round: 2 }), /轮次已更新/)
  assert.deepEqual(await store.get(session.id), saved)
})

test('later rounds reject missing or stale round numbers even when revision and fingerprint are unchanged', async t => {
  const { store, directory, session } = await setup(t)
  const { round: _initialRound, ...legacy } = commentBatch(session)
  const first = await store.mutate(session.id, legacy)
  assert.equal(first.review.comments.length, 1)
  const two = await store.revise(session.id, revision(first))
  const { round: _secondRound, ...missingRound } = commentBatch(two, '不得误写入后续轮次')
  const path = join(directory, `${session.id}.json`)
  const secondRaw = await readFile(path, 'utf8')
  await assert.rejects(store.mutate(session.id, missingRound), { status: 409, message: /轮次/ })
  assert.equal(await readFile(path, 'utf8'), secondRaw)
  const staleRound = commentBatch(two)
  const three = await store.revise(session.id, revision(two))
  assert.equal(three.review.revision, two.review.revision)
  assert.equal(three.review.snapshot.fingerprint, two.review.snapshot.fingerprint)
  const thirdRaw = await readFile(path, 'utf8')
  for (const batch of [missingRound, staleRound]) {
    await assert.rejects(store.mutate(session.id, batch), { status: 409, message: /轮次/ })
    assert.equal(await readFile(path, 'utf8'), thirdRaw)
  }
  assert.deepEqual(await store.get(session.id), three)
})

test('agent reply retry is idempotent and cannot reopen an approved round', async t => {
  const { store, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const batch = replyBatch(saved)
  const replied = await store.mutate(session.id, batch)
  assert.deepEqual(await store.mutate(session.id, batch), replied)
  const published = await store.revise(session.id, revision(replied))
  const resolved = await store.mutate(session.id, statusBatch(published, 'resolved'))
  const approved = await store.finish(session.id, { kind: 'approval', expectedVersion: resolved.version })
  const retry = { ...batch, round: approved.round, revision: approved.review.revision, fingerprint: approved.review.snapshot.fingerprint }
  assert.deepEqual(await store.mutate(session.id, retry), approved)
})

test('legacy sessions stay readable and preserve missing origin metadata on publication', async t => {
  const { store, directory, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const legacy = structuredClone(saved)
  delete legacy.review.comments[0].originRound
  const path = join(directory, `${session.id}.json`)
  await writeFile(path, JSON.stringify(legacy))
  const loaded = await new SessionStore(directory).get(session.id)
  assert.equal(loaded.review.comments[0].originRound, undefined)
  const request = revision(loaded)
  request.review.comments[0].originRound = 2
  const next = await store.revise(session.id, request)
  assert.equal(next.review.comments[0].originRound, undefined)
  assert.equal(next.snapshots[0].publication, undefined)
})

test('corrupted persisted publication and future comment rounds are rejected without replacement', async t => {
  const { store, directory, session } = await setup(t)
  const published = await store.revise(session.id, revision(session))
  const path = join(directory, `${session.id}.json`)
  const broken = structuredClone(published)
  broken.snapshots[1].publication!.source.fingerprint = '0'.repeat(64)
  const raw = JSON.stringify(broken)
  await writeFile(path, raw)
  await assert.rejects(store.get(session.id), /原文件已保留.*指纹不一致/)
  assert.equal(await readFile(path, 'utf8'), raw)
  const future = structuredClone(published)
  future.review = addComment(future.review, [{ kind: 'review', id: future.review.id }], '非法未来轮次')
  future.review.comments[0].originRound = 3
  await writeFile(path, JSON.stringify(future))
  await assert.rejects(store.get(session.id), /轮次超出/)
})

test('Windows revalidates same-size external corruption when file metadata collides', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalStat = fs.stat
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    const { store, directory, session } = await setup(t)
    const published = await store.revise(session.id, revision(session))
    await store.get(session.id)
    const path = join(directory, `${session.id}.json`)
    const metadata = await originalStat(path, { bigint: true })
    const before = await readFile(path, 'utf8')
    const broken = structuredClone(published)
    broken.snapshots[1].publication!.source.fingerprint = '0'.repeat(64)
    const raw = JSON.stringify(broken)
    assert.equal(Buffer.byteLength(raw), Buffer.byteLength(before))
    await writeFile(path, raw)
    t.mock.method(fs, 'stat', (...args: Parameters<typeof stat>) => args[0] === path ? Promise.resolve(metadata) : originalStat(...args))
    syncBuiltinESMExports()
    await assert.rejects(store.get(session.id), /原文件已保留.*指纹不一致/)
    assert.equal(await readFile(path, 'utf8'), raw)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', platform)
  }
})

for (const mode of ['delete', 'archive'] as const) test(`${mode} between file read and metadata validation returns its lifecycle status instead of corruption`, async t => {
  const { store, directory, session } = await setup(t)
  const reader = new SessionStore(directory)
  const path = join(directory, `${session.id}.json`)
  const originalStat = fs.stat
  let reads = 0
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof stat>) => {
    if (args[0] === path && ++reads === 2) await store.cleanup(session.id, { mode, expectedVersion: session.version, allowUnfinished: true })
    return originalStat(...args)
  })
  try {
    syncBuiltinESMExports()
    await assert.rejects(reader.get(session.id), { status: mode === 'delete' ? 404 : 410 })
    await assert.rejects(readFile(path), { code: 'ENOENT' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

for (const mode of ['delete', 'archive'] as const) for (const failedAt of [1, 2]) test(`Windows EPERM at stat ${failedAt} confirms ${mode} without reporting corruption`, async t => {
  const { store, directory, session } = await setup(t)
  const reader = new SessionStore(directory)
  const path = join(directory, `${session.id}.json`)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalStat = fs.stat
  let reads = 0
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof stat>) => {
    if (args[0] === path && ++reads === failedAt) {
      await store.cleanup(session.id, { mode, expectedVersion: session.version, allowUnfinished: true })
      throw Object.assign(new Error('delete pending'), { code: 'EPERM' })
    }
    return originalStat(...args)
  })
  try {
    syncBuiltinESMExports()
    await assert.rejects(reader.get(session.id), { status: mode === 'delete' ? 404 : 410 })
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, 'platform', platform)
  }
})

for (const probeDenied of [false, true]) test(`Windows EPERM preserves real access failures (probe denied: ${probeDenied})`, async t => {
  const { directory, session } = await setup(t)
  const path = join(directory, `${session.id}.json`)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalRead = fs.readFile, originalStat = fs.stat
  let denied = false
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  t.mock.method(fs, 'readFile', (...args: Parameters<typeof readFile>) => {
    if (args[0] !== path) return originalRead(...args)
    denied = true
    return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EPERM' }))
  })
  t.mock.method(fs, 'stat', (...args: Parameters<typeof stat>) => args[0] === path && denied && probeDenied
    ? Promise.reject(Object.assign(new Error('probe permission denied'), { code: 'EPERM' })) : originalStat(...args))
  try {
    syncBuiltinESMExports()
    await assert.rejects(new SessionStore(directory).get(session.id), { status: 500 })
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, 'platform', platform)
  }
})

test('Finish packages only new human feedback, and does not resubmit unchanged open opinions', async t => {
  const { store, session } = await setup(t)
  const first = await store.mutate(session.id, commentBatch(session, '第一条意见'))
  const submitted = await store.finish(session.id, { kind: 'feedback', expectedVersion: first.version })
  await assert.rejects(store.finish(session.id, { kind: 'feedback', expectedVersion: submitted.version }), /没有新的/)
  const second = await store.mutate(session.id, commentBatch(submitted, '第二条意见'))
  const next = await store.finish(session.id, { kind: 'feedback', expectedVersion: second.version })
  assert.equal(next.review.comments.length, 2)
  assert.deepEqual(next.history[1].review.comments.map(item => item.body), ['第二条意见'])
  assert.deepEqual(next.history[0], submitted.history[0])
})

test('corrupted store fails without replacing original; invalid ids cannot traverse directories', async t => {
  const { store, directory, session } = await setup(t)
  const path = join(directory, `${session.id}.json`)
  await writeFile(path, '{ damaged')
  await assert.rejects(store.get(session.id), /原文件已保留/)
  await assert.rejects(store.mutate(session.id, commentBatch(session)), /原文件已保留/)
  assert.equal(await readFile(path, 'utf8'), '{ damaged')
  await assert.rejects(store.get('../secret'), /标识无效/)
})

test('long polling observes actual versions and handles timeout and abort', async t => {
  const { store, session } = await setup(t)
  assert.equal(await store.waitForChange(session.id, session.version, 5), null)
  const waiting = store.waitForChange(session.id, session.version, 1000)
  const saved = await store.mutate(session.id, commentBatch(session))
  assert.deepEqual(await waiting, saved)
  const controller = new AbortController()
  const aborted = store.waitForChange(session.id, saved.version, 1000, controller.signal)
  controller.abort()
  assert.equal(await aborted, null)
})

test('current views retain submission identity across status changes and return independent values', async t => {
  const { store, session } = await setup(t)
  const saved = await store.mutate(session.id, commentBatch(session))
  const submitted = await store.finish(session.id, { kind: 'feedback', expectedVersion: saved.version })
  const checked = await store.mutate(session.id, statusBatch(submitted, 'needs-review'))
  const view = await store.get(session.id, 'current')
  assert.equal(view.view, 'current')
  assert.deepEqual(view.submittedCommentIds, [saved.review.comments[0].id])
  assert.deepEqual(view.commentOrigins, [{ commentId: saved.review.comments[0].id, round: 1, exact: true }])
  view.review.comments[0].body = '不得篡改缓存'
  view.snapshots[0].openedAt = 'invalid'
  const full = await store.get(session.id)
  full.review.nodes[0].title = '也不得篡改完整接口的缓存'
  full.history[0].review.comments[0].body = '不得改写固定记录'
  assert.deepEqual(await store.get(session.id), checked)
  const snapshot = await store.getSnapshot(session.id, 1)
  snapshot.review.nodes[0].title = '不得改写原图'
  assert.deepEqual(await store.getSnapshot(session.id, 1), checked.snapshots[0])
  const record = await store.getRecord(session.id, checked.history[0].id)
  record.review.comments[0].body = '不得改写意见包'
  assert.deepEqual(await store.getRecord(session.id, record.id), checked.history[0])
  const next = addReply(checked.review, checked.review.comments[0].id, '新增人类内容尚未提交', 'reviewer')
  await store.mutate(session.id, { round: checked.round, revision: checked.review.revision, fingerprint: checked.review.snapshot.fingerprint,
    mutations: [{ kind: 'add-reply', commentId: checked.review.comments[0].id, reply: next.comments[0].replies![0] }] })
  assert.deepEqual((await store.get(session.id, 'current')).submittedCommentIds, [])
})

test('cached sessions detect external edits, same-size corruption and deletion', async t => {
  const { store, directory, session } = await setup(t)
  const path = join(directory, `${session.id}.json`)
  await store.get(session.id)
  const external = structuredClone(session)
  external.review.title = '外部合法更新'
  await writeFile(path, JSON.stringify(external))
  assert.equal((await store.get(session.id)).review.title, '外部合法更新')
  const previous = await stat(path)
  const damaged = Buffer.alloc(previous.size, ' ')
  await writeFile(path, damaged)
  await utimes(path, previous.atime, previous.mtime)
  await assert.rejects(store.get(session.id, 'current'), /原文件已保留/)
  await assert.rejects(store.mutate(session.id, commentBatch(external)), /原文件已保留/)
  assert.deepEqual(await readFile(path), damaged)
  await writeFile(path, JSON.stringify(external))
  assert.equal((await store.get(session.id, 'current')).review.title, '外部合法更新')
  await unlink(path)
  await assert.rejects(store.get(session.id), { status: 404 })
})

test('growing review history crosses the former 32 MiB limit without dropping data', async t => {
  const { store, directory, session } = await setup(t)
  const review = structuredClone(session.review)
  const prototype = commentBatch(session).mutations[0].comment
  review.comments = Array.from({ length: 110 }, (_, index) => ({ ...prototype, id: `size-comment-${index}`, originRound: 1, body: 'x' }))
  const seeded = { ...session, round: 30, review, snapshots: Array.from({ length: 30 }, (_, index) => ({
    round: index + 1, openedAt: session.createdAt, review: structuredClone(review),
  })) }
  const targetBytes = 32 * 1024 * 1024 - 1000
  const reviews = [seeded.review, ...seeded.snapshots.map(snapshot => snapshot.review)]
  const slots = reviews.length * review.comments.length
  const bodyLength = 1 + Math.floor((targetBytes - Buffer.byteLength(JSON.stringify(seeded))) / slots)
  for (const item of reviews) for (const comment of item.comments) comment.body = 'x'.repeat(bodyLength)
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(seeded))
  for (const comment of review.comments) {
    const extra = Math.min(remaining, 10000 - comment.body.length)
    comment.body += 'x'.repeat(extra); remaining -= extra
  }
  assert.equal(remaining, 0)
  const raw = JSON.stringify(seeded)
  assert.equal(Buffer.byteLength(raw), targetBytes)
  const path = join(directory, `${session.id}.json`)
  await writeFile(path, raw)
  const before = await store.get(session.id, 'current')
  const saved = await store.mutate(session.id, commentBatch(seeded, 'x'.repeat(10000)), 'current')
  assert.equal(saved.version, before.version + 1)
  assert.equal(saved.review.comments.length, before.review.comments.length + 1)
  assert.ok((await stat(path)).size > 32 * 1024 * 1024)
  const restarted = await new SessionStore(directory).get(session.id, 'current')
  assert.deepEqual(restarted, saved)
})
