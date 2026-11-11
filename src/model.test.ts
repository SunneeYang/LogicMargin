import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addComment, addReply, editDiscussion, getChanges, parseReview, parseReviewBaseline, rebaseReview, serializeReview, setCommentStatus, targetExists, targetLabel, targetSceneId } from './model.ts'
import type { ReviewDocument } from './types.ts'
import { sampleReview } from './sample.ts'

function fixture(): ReviewDocument {
  return {
    schemaVersion: 1, id: 'review', title: '订阅设置', description: '', revision: 'v1',
    snapshot: { repository: '/example-project', commit: 'abc', fingerprint: 'hash1', capturedAt: '2026-11-02T00:00:00Z', dirty: true },
    coverage: { included: ['升级'], excluded: ['续期'], note: '人工核对' },
    scenes: [{ id: 'level', title: '升级', description: '' }],
    nodes: ['check', 'done'].map((id, index) => ({ id, sceneId: 'level', title: id, kind: 'action', summary: '', detail: '', input: '', output: '',
      position: { x: index * 200, y: 0 }, evidence: [{ path: 'subscription.go', symbol: 'LevelUp', startLine: 1, endLine: 10, digest: 'abc' }] })),
    edges: [{ id: 'pass', sceneId: 'level', source: 'check', target: 'done', label: '通过', detail: '' }], comments: [],
  }
}

test('bundled fictional sample is a valid importable review', () => {
  assert.deepEqual(parseReview(sampleReview), sampleReview)
  assert.ok(sampleReview.nodes.every(node => node.evidence.length > 0))
})

test('target labels localize only interface text and preserve authored names', () => {
  const review = fixture()
  const format = (source: string, values: Record<string, string> = {}) => source === '连线 · {label}' ? `Connection · ${values.label}` : 'Translated label'
  assert.equal(targetLabel(review, { kind: 'edge', id: 'pass' }, format), 'Connection · 通过')
  assert.equal(targetLabel(review, { kind: 'node', id: 'check' }, format), 'check')
  assert.equal(targetLabel(review, { kind: 'review', id: review.id }, format), 'Translated label')
})

test('fixed baselines survive file exchange and imports without accepting nesting or replacement', () => {
  const baseline = fixture()
  baseline.revision = 'original-code'
  const current = { ...fixture(), revision: 'first-review', baseline }
  assert.deepEqual(parseReview(JSON.parse(serializeReview(current))), current)
  assert.deepEqual(parseReviewBaseline(baseline, current.id), baseline)
  assert.throws(() => parseReview({ ...current, baseline: { ...baseline, id: 'another-review' } }), /相同评审 ID/)
  assert.throws(() => parseReview({ ...current, baseline: { ...baseline, baseline } }), /嵌套/)
  assert.throws(() => parseReview({ ...current, baseline: addComment(baseline, [{ kind: 'node', id: 'check' }], '旧批注') }), /不能包含批注/)
  assert.deepEqual(rebaseReview(fixture(), current).baseline, baseline)
  assert.deepEqual(rebaseReview(current, { ...fixture(), revision: 'second-review' }).baseline, baseline)
  assert.throws(() => rebaseReview(current, { ...current, baseline: { ...baseline, revision: 'replacement' } }), /不能随新版替换/)
  assert.equal(fixture().baseline, undefined)
})

test('baseline comments keep original targets after the implementation removes them and cannot change basis', () => {
  const baseline = fixture()
  const current = { ...fixture(), nodes: fixture().nodes.slice(1), edges: [], baseline }
  const target = { kind: 'node' as const, id: 'check' }
  assert.throws(() => addComment(current, [target], '目标已移除'), /已移除/)
  const annotated = addComment(current, [target], '请改造原来的条件检查', 'baseline')
  assert.equal(annotated.comments[0].basis, 'baseline')
  assert.equal(parseReview(annotated).comments[0].status, 'open')
  const { baseline: _baseline, ...compact } = annotated
  assert.throws(() => parseReview(compact), /基线批注/)
  assert.equal(parseReview(compact, { allowBaselineReferences: true }).comments[0].status, 'open')
  assert.throws(() => parseReview({ ...annotated, comments: [{ ...annotated.comments[0], basis: 'current' }] }), /批注依据/)
  assert.throws(() => parseReview({ ...annotated, comments: [{ ...annotated.comments[0], targets: [{ kind: 'node', id: 'not-in-B' }] }] }, { allowBaselineReferences: true }), /基线批注/)
  assert.throws(() => rebaseReview(annotated, { ...annotated, comments: [{ ...annotated.comments[0], basis: undefined }] }), /冲突/)
})

test('validates and round trips an exported review without retaining unknown fields', () => {
  const review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '  条件不足时不能扣费  ')
  assert.deepEqual(parseReview(JSON.parse(JSON.stringify(review))), review)
  assert.equal(review.comments[0].body, '条件不足时不能扣费')
  assert.equal('unknown' in parseReview({ ...review, unknown: 'ignored' }), false)
})

test('optional saved source snippets round trip and reject malformed or unbound content', () => {
  const review = fixture()
  const evidence = review.nodes[0].evidence[0]
  evidence.startLine = 3
  evidence.endLine = 4
  evidence.digest = 'a'.repeat(64)
  evidence.code = 'check()\nrun()'
  review.snapshot.files = [{ path: evidence.path, sha256: 'b'.repeat(64) }]
  assert.deepEqual(parseReview(JSON.parse(serializeReview(review))), review)
  for (const code of ['one line', 'check()\r\nrun()', 'x'.repeat(100_001), 'check()\n\0']) {
    assert.throws(() => parseReview({ ...review, nodes: [{ ...review.nodes[0], evidence: [{ ...evidence, code }] }, review.nodes[1]] }), /源码片段/)
  }
  for (const patch of [{ digest: 'legacy-digest' }, { endLine: 2003, code: Array(2001).fill('x').join('\n') }]) {
    assert.throws(() => parseReview({ ...review, nodes: [{ ...review.nodes[0], evidence: [{ ...evidence, ...patch }] }, review.nodes[1]] }), /源码片段/)
  }
  delete review.snapshot.files
  assert.throws(() => parseReview(review), /来源文件清单/)
  delete evidence.code
  assert.deepEqual(parseReview(review), review)
})

test('rejects broken schemas, IDs, graph references, coordinates, evidence and comments', () => {
  const invalid = [
    (r: ReviewDocument) => ({ ...r, schemaVersion: 2 }),
    (r: ReviewDocument) => ({ ...r, scenes: [] }),
    (r: ReviewDocument) => ({ ...r, nodes: [...r.nodes, r.nodes[0]] }),
    (r: ReviewDocument) => ({ ...r, edges: [{ ...r.edges[0], target: 'missing' }] }),
    (r: ReviewDocument) => ({ ...r, nodes: [{ ...r.nodes[0], sceneId: 'missing' }] }),
    (r: ReviewDocument) => ({ ...r, nodes: [{ ...r.nodes[0], position: { x: Infinity, y: 0 } }] }),
    (r: ReviewDocument) => ({ ...r, nodes: [{ ...r.nodes[0], evidence: [{ ...r.nodes[0].evidence[0], startLine: 12 }] }] }),
    (r: ReviewDocument) => ({ ...r, nodes: [{ ...r.nodes[0], kind: 'script' }] }),
    (r: ReviewDocument) => ({ ...r, snapshot: { ...r.snapshot, dirty: 'true' } }),
    (r: ReviewDocument) => ({ ...r, comments: [{ id: 'c', body: 'a', targets: [], status: 'open', createdAt: 'invalid', revision: 'v1' }] }),
    (r: ReviewDocument) => ({ ...r, title: 'a'.repeat(201) }),
  ]
  for (const makeInvalid of invalid) assert.throws(() => parseReview(makeInvalid(fixture())))
  for (const value of [null, [], 'text', {}]) assert.throws(() => parseReview(value))
  const r = fixture()
  r.scenes.push({ id: 'other', title: '其他', description: '' })
  r.nodes[1].sceneId = 'other'
  assert.throws(() => parseReview(r), /同一场景/)
})

test('new comments require current unique anchors and nonempty bounded text without mutating the review', () => {
  const r = fixture()
  assert.throws(() => addComment(r, [], '意见'))
  assert.throws(() => addComment(r, [{ kind: 'node', id: 'gone' }], '意见'))
  assert.throws(() => addComment(r, [{ kind: 'node', id: 'check' }], '  '))
  assert.throws(() => addComment(r, [{ kind: 'node', id: 'check' }], 'a'.repeat(10001)))
  assert.throws(() => addComment(r, [{ kind: 'node', id: 'check' }, { kind: 'node', id: 'check' }], '重复'))
  const next = addComment(r, [{ kind: 'node', id: 'check' }, { kind: 'edge', id: 'pass' }], '检查执行顺序')
  assert.equal(r.comments.length, 0)
  assert.equal(next.comments.length, 1)
  assert.equal(next.comments[0].targets.length, 2)
  assert.equal(next.comments[0].status, 'open')
})

test('human resolutions survive unrelated versions and snapshots without rewriting their confirmation', () => {
  const r = addComment(fixture(), [{ kind: 'node', id: 'check' }], '检查')
  const resolved = setCommentStatus(r, r.comments[0].id, 'resolved')
  resolved.comments[0].reviewedRound = 1
  const confirmation = structuredClone(resolved.comments[0])
  const other = fixture()
  other.nodes[1].detail = '其他步骤的新规则'
  for (const next of [{ ...fixture(), revision: 'v2' }, { ...fixture(), snapshot: { ...fixture().snapshot, fingerprint: 'hash2' } },
    { ...other, revision: 'v2', snapshot: { ...other.snapshot, fingerprint: 'hash2' } }]) {
    const rebased = rebaseReview(resolved, next)
    assert.deepEqual(rebased.comments[0], confirmation)
    assert.deepEqual(parseReview(JSON.parse(serializeReview(rebased))), rebased)
    const imported = { ...next, comments: [confirmation] }
    assert.deepEqual(rebaseReview(next, imported).comments[0], confirmation)
    assert.deepEqual(rebaseReview(rebased, { ...next, revision: 'v3' }).comments[0], confirmation)
    assert.equal(rebaseReview(r, next).comments[0].status, 'needs-review')
  }
  assert.deepEqual(resolved.comments[0], confirmation)
})

test('source line moves preserve confirmed scopes while the ordinary diff still records reference locations', () => {
  let review = fixture()
  for (const target of [{ kind: 'node', id: 'check' }, { kind: 'edge', id: 'pass' }, { kind: 'scene', id: 'level' }, { kind: 'review', id: 'review' }] as const) {
    review = addComment(review, [target], '已核对')
    review = setCommentStatus(review, review.comments.at(-1)!.id, 'resolved')
  }
  const shifted = fixture()
  shifted.revision = 'v2'
  shifted.snapshot.fingerprint = 'hash2'
  shifted.nodes[0].evidence[0].startLine += 20
  shifted.nodes[0].evidence[0].endLine += 20
  assert.deepEqual(getChanges(review, shifted).changed, [{ kind: 'node', id: 'check' }])
  assert.deepEqual(rebaseReview(review, shifted).comments, review.comments)
  const changedCode = structuredClone(shifted)
  changedCode.nodes[0].evidence[0].digest = 'changed-code'
  assert.deepEqual(rebaseReview(review, changedCode).comments.map(comment => comment.status), ['needs-review', 'resolved', 'needs-review', 'needs-review'])
  const changedRule = structuredClone(shifted)
  changedRule.nodes[0].detail = '已确认步骤的新规则'
  assert.deepEqual(rebaseReview(review, changedRule).comments.map(comment => comment.status), ['needs-review', 'resolved', 'needs-review', 'needs-review'])
  const changedEdge = structuredClone(shifted)
  changedEdge.edges[0].detail = '新的流转条件'
  assert.deepEqual(rebaseReview(review, changedEdge).comments.map(comment => comment.status), ['resolved', 'needs-review', 'needs-review', 'needs-review'])
})

test('confirmed baseline and removed-target resolutions survive later unrelated rounds', () => {
  const baseline = fixture()
  let current = addComment({ ...fixture(), nodes: fixture().nodes.slice(1), edges: [], baseline }, [{ kind: 'node', id: 'check' }], '基线要求', 'baseline')
  current = setCommentStatus(current, current.comments[0].id, 'resolved')
  const next = { ...structuredClone(current), revision: 'v2', comments: [] }
  assert.deepEqual(rebaseReview(current, next).comments, current.comments)
  assert.deepEqual(parseReview({ ...next, comments: current.comments }).comments, current.comments)

  const ordinary = addComment(fixture(), [{ kind: 'node', id: 'check' }], '原位置')
  const resolved = setCommentStatus(ordinary, ordinary.comments[0].id, 'resolved')
  const removed = { ...fixture(), nodes: fixture().nodes.slice(1), edges: [], revision: 'v2' }
  const rebased = rebaseReview(resolved, removed)
  assert.equal(rebased.comments[0].status, 'needs-review')
  const confirmed = setCommentStatus(rebased, rebased.comments[0].id, 'resolved')
  assert.deepEqual(rebaseReview(confirmed, { ...removed, revision: 'v3' }).comments, confirmed.comments)
  assert.deepEqual(parseReview({ ...removed, revision: 'v3', comments: confirmed.comments }).comments, confirmed.comments)
})

test('semantic changes flag affected comments while layout changes preserve status', () => {
  const r = addComment(fixture(), [{ kind: 'node', id: 'check' }], '检查')
  const moved = fixture()
  moved.nodes[0].position.x = 100
  assert.deepEqual(getChanges(r, moved), { added: [], changed: [], removed: [] })
  assert.equal(rebaseReview(r, moved).comments[0].status, 'open')
  const changed = fixture()
  changed.nodes[0].detail = '新的规则'
  assert.deepEqual(getChanges(r, changed).changed, [{ kind: 'node', id: 'check' }])
  assert.equal(rebaseReview(r, changed).comments[0].status, 'needs-review')
  const other = fixture()
  other.nodes[1].detail = '另一个步骤改变'
  assert.equal(rebaseReview(r, other).comments[0].status, 'open')
})

test('removed anchors survive import and rebase as comments awaiting review', () => {
  const r = addComment(fixture(), [{ kind: 'node', id: 'check' }, { kind: 'edge', id: 'pass' }], '原流程')
  const next = fixture()
  next.nodes = next.nodes.filter(node => node.id !== 'check')
  next.edges = []
  const rebased = rebaseReview(r, next)
  assert.equal(rebased.comments[0].status, 'needs-review')
  assert.deepEqual(rebased.comments[0].targets, r.comments[0].targets)
  assert.deepEqual(parseReview(JSON.parse(JSON.stringify(rebased))), rebased)
  assert.deepEqual(getChanges(r, next).removed, [{ kind: 'node', id: 'check' }, { kind: 'edge', id: 'pass' }])
})

test('merges new comments without auto resolving local opinions, and rejects conflicting identities', () => {
  const local = addComment(fixture(), [{ kind: 'node', id: 'check' }], '本地意见')
  const incoming = addComment(structuredClone(local), [{ kind: 'edge', id: 'pass' }], '导入意见')
  incoming.comments[0].status = 'resolved'
  incoming.comments[1].revision = 'old'
  const merged = rebaseReview(local, incoming)
  assert.equal(merged.comments.length, 2)
  assert.equal(merged.comments[0].status, 'open')
  assert.equal(merged.comments[1].status, 'needs-review')
  incoming.comments[0].body = '冲突内容'
  assert.throws(() => rebaseReview(local, incoming), /冲突/)
  assert.throws(() => rebaseReview(local, { ...fixture(), id: 'other' }), /相同评审 ID/)
  assert.throws(() => setCommentStatus(local, 'missing', 'resolved'), /找不到/)
})

test('detects additions and edge behavior changes', () => {
  const next = fixture()
  next.nodes.push({ ...next.nodes[0], id: 'new' })
  next.edges[0].detail = '新增失败处理'
  assert.deepEqual(getChanges(fixture(), next), { added: [{ kind: 'node', id: 'new' }], changed: [{ kind: 'edge', id: 'pass' }], removed: [] })
})

test('large merged reviews remain exportable and importable without truncation', () => {
  const local = fixture()
  const incoming = fixture()
  const comment = addComment(fixture(), [{ kind: 'node', id: 'check' }], 'a'.repeat(9000)).comments[0]
  local.comments = Array.from({ length: 600 }, (_, index) => ({ ...comment, id: `local-${index}` }))
  incoming.comments = Array.from({ length: 600 }, (_, index) => ({ ...comment, id: `incoming-${index}` }))
  assert.doesNotThrow(() => parseReview(local))
  assert.doesNotThrow(() => parseReview(incoming))
  const merged = rebaseReview(local, incoming)
  const serialized = serializeReview(merged)
  assert.ok(new TextEncoder().encode(serialized).byteLength > 10 * 1024 * 1024)
  assert.equal(parseReview(JSON.parse(serialized)).comments.length, 1200)
  assert.equal(local.comments.length, 600)
  assert.equal(incoming.comments.length, 600)
})

test('comment counts and round numbers grow without business ceilings while invalid rounds are rejected', () => {
  const base = addComment(fixture(), [{ kind: 'node', id: 'check' }], '意见')
  const review = { ...base, comments: Array.from({ length: 2001 }, (_, index) => ({ ...base.comments[0], id: `comment-${index}` })) }
  const parsed = parseReview(review)
  assert.equal(parsed.comments.length, 2001)
  assert.equal(addComment(parsed, [{ kind: 'node', id: 'check' }], '继续评审').comments.length, 2002)
  assert.equal(rebaseReview(parsed, base).comments.length, 2002)
  const replied = addReply(base, base.comments[0].id, '回复')
  replied.comments[0].originRound = Number.MAX_SAFE_INTEGER
  replied.comments[0].reviewedRound = Number.MAX_SAFE_INTEGER
  replied.comments[0].replies![0].round = Number.MAX_SAFE_INTEGER
  assert.deepEqual(parseReview(replied), replied)
  for (const round of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseReview({ ...base, comments: [{ ...base.comments[0], originRound: round }] }), /正整数/)
    assert.throws(() => parseReview({ ...base, comments: [{ ...base.comments[0], reviewedRound: round }] }), /正整数/)
    assert.throws(() => parseReview({ ...replied, comments: [{ ...replied.comments[0], replies: [{ ...replied.comments[0].replies![0], round }] }] }), /正整数/)
  }
})

test('standalone imports flag stale opinions and preserve a human resolution after target removal', () => {
  const r = addComment(fixture(), [{ kind: 'node', id: 'check' }], '待验证')
  r.comments[0].status = 'resolved'
  r.comments[0].revision = 'old'
  assert.equal(parseReview(r).comments[0].status, 'needs-review')
  const removed = fixture()
  removed.nodes = []
  removed.edges = []
  const rebased = rebaseReview(r, removed)
  assert.equal(rebased.comments[0].status, 'needs-review')
  const confirmed = setCommentStatus(rebased, rebased.comments[0].id, 'resolved')
  assert.equal(parseReview(confirmed).comments[0].status, 'resolved')
  assert.equal(rebaseReview(confirmed, removed).comments[0].status, 'resolved')
  assert.equal(r.comments[0].status, 'resolved')
})

test('scene and review comments require current anchors while imported orphan scopes survive', () => {
  let review = fixture()
  review = addComment(review, [{ kind: 'scene', id: 'level' }], '场景范围')
  review = addComment(review, [{ kind: 'review', id: review.id }], '整体范围')
  assert.deepEqual(parseReview(review), review)
  assert.throws(() => addComment(review, [{ kind: 'scene', id: 'missing' }], '不存在'))
  assert.throws(() => addComment(review, [{ kind: 'review', id: 'other' }], '不存在'))
  assert.equal(targetExists(review, { kind: 'review', id: 'review' }), true)
  assert.equal(targetExists(review, { kind: 'scene', id: 'missing' }), false)
  assert.equal(targetSceneId(review, { kind: 'edge', id: 'pass' }), 'level')
  assert.equal(targetSceneId(review, { kind: 'scene', id: 'level' }), 'level')
  assert.equal(targetSceneId(review, { kind: 'review', id: review.id }), undefined)
  assert.equal(targetLabel(review, { kind: 'node', id: 'check' }), 'check')
  assert.equal(targetLabel(review, { kind: 'edge', id: 'pass' }), '连线 · 通过')
  assert.equal(targetLabel(review, { kind: 'scene', id: 'level' }), '场景 · 升级')
  assert.equal(targetLabel(review, { kind: 'review', id: review.id }), '整个评审')
  review.comments[0].targets = [{ kind: 'scene', id: 'missing' }]
  review.comments[1].targets = [{ kind: 'review', id: 'old-id' }]
  const imported = parseReview(review)
  assert.ok(imported.comments.every(comment => comment.status === 'needs-review'))
  assert.deepEqual(imported.comments.map(comment => comment.targets), review.comments.map(comment => comment.targets))
})

test('scope comments follow semantic additions and metadata changes but ignore positions and other scenes', () => {
  let review = fixture()
  review.scenes.push({ id: 'other', title: '其他', description: '' })
  review = addComment(review, [{ kind: 'scene', id: 'level' }], '场景意见')
  review = addComment(review, [{ kind: 'review', id: review.id }], '整体意见')
  const moved = structuredClone(review)
  moved.nodes[0].position = { x: 100, y: 200 }
  assert.deepEqual(rebaseReview(review, moved).comments.map(comment => comment.status), ['open', 'open'])
  const added = structuredClone(review)
  added.nodes.push({ ...added.nodes[0], id: 'added' })
  assert.deepEqual(rebaseReview(review, added).comments.map(comment => comment.status), ['needs-review', 'needs-review'])
  const otherScene = structuredClone(review)
  otherScene.scenes[1].description = '不同场景改变'
  assert.deepEqual(rebaseReview(review, otherScene).comments.map(comment => comment.status), ['open', 'needs-review'])
  const metadata = structuredClone(review)
  metadata.scenes[0].description = '当前场景改变'
  assert.deepEqual(rebaseReview(review, metadata).comments.map(comment => comment.status), ['needs-review', 'needs-review'])
  const coverage = structuredClone(review)
  coverage.coverage.excluded.push('重置')
  assert.deepEqual(rebaseReview(review, coverage).comments.map(comment => comment.status), ['open', 'needs-review'])
})

test('reply creation stays attached to its original comment and never resolves it automatically', () => {
  const review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '原意见')
  const replied = addReply(review, review.comments[0].id, '  补充约束  ')
  assert.equal(review.comments[0].replies, undefined)
  assert.equal(replied.comments.length, 1)
  assert.equal(replied.comments[0].body, '原意见')
  assert.equal(replied.comments[0].replies?.[0].body, '补充约束')
  assert.equal(replied.comments[0].replies?.[0].author, 'reviewer')
  assert.equal(replied.comments[0].status, 'open')
  const resolved = setCommentStatus(replied, replied.comments[0].id, 'resolved')
  const agent = addReply(resolved, replied.comments[0].id, '已经修改，请复核', 'agent')
  assert.equal(agent.comments[0].status, 'needs-review')
  assert.deepEqual(parseReview(agent), agent)
  assert.throws(() => addReply(review, 'missing', '回复'), /找不到/)
  assert.throws(() => addReply(review, review.comments[0].id, '  '))
  assert.throws(() => addReply(review, review.comments[0].id, 'a'.repeat(10001)))
})

test('editing a discussion preserves its identity, order and timestamps and rejects stale text', () => {
  const commented = addComment(fixture(), [{ kind: 'node', id: 'check' }], '原意见')
  const before = addReply(commented, commented.comments[0].id, '原补充')
  const c = before.comments[0], reply = c.replies![0]
  const edited = editDiscussion(before, c.id, '  修改意见  ', c.body)
  assert.deepEqual(edited.comments[0], { ...c, body: '修改意见' })
  assert.equal(before.comments[0].body, '原意见')
  assert.deepEqual(editDiscussion(edited, c.id, '修改补充', reply.body, reply.id).comments[0],
    { ...c, body: '修改意见', replies: [{ ...reply, body: '修改补充' }] })
  assert.throws(() => editDiscussion(edited, c.id, '覆盖', c.body), /已有更新/)
  assert.throws(() => editDiscussion(before, c.id, ' ', c.body), /批注内容/)
  assert.throws(() => editDiscussion(before, c.id, 'a'.repeat(10001), c.body), /批注内容/)
  const agent = addReply(before, c.id, '代理说明', 'agent').comments[0].replies!.at(-1)!
  assert.throws(() => editDiscussion({ ...before, comments: [{ ...c, replies: [agent] }] }, c.id, '覆盖', agent.body, agent.id), /代理回复/)
})

test('validates reply identities and preserves absence in legacy files', () => {
  const review = addComment(fixture(), [{ kind: 'node', id: 'check' }], '意见')
  assert.equal('replies' in parseReview(review).comments[0], false)
  assert.equal('reviewedRevision' in parseReview(review).comments[0], false)
  const replied = addReply(review, review.comments[0].id, '回复')
  const reply = replied.comments[0].replies![0]
  for (const invalid of [{ ...reply, id: '' }, { ...reply, author: 'unknown' }, { ...reply, body: '' },
    { ...reply, createdAt: 'invalid' }, { ...reply, revision: '' }]) {
    assert.throws(() => parseReview({ ...replied, comments: [{ ...replied.comments[0], replies: [invalid] }] }))
  }
  assert.throws(() => parseReview({ ...replied, comments: [{ ...replied.comments[0], replies: [reply, reply] }] }), /重复/)
  const full = { ...replied, comments: [{ ...replied.comments[0], replies: Array.from({ length: 500 }, (_, index) => ({ ...reply, id: `${index}` })) }] }
  assert.doesNotThrow(() => parseReview(full))
  assert.equal(parseReview(addReply(full, review.comments[0].id, '更多')).comments[0].replies?.length, 501)
})

test('reply imports merge idempotently, reject conflicts, and retain a manual resolution after reimport', () => {
  const local = addComment(fixture(), [{ kind: 'node', id: 'check' }], '原意见')
  const id = local.comments[0].id
  const incoming = addReply(local, id, '代理回应', 'agent')
  const first = rebaseReview(local, incoming)
  assert.equal(first.comments[0].status, 'needs-review')
  assert.equal(first.comments[0].replies?.length, 1)
  const resolved = setCommentStatus(first, id, 'resolved')
  const repeated = rebaseReview(resolved, incoming)
  assert.equal(repeated.comments[0].status, 'resolved')
  assert.equal(repeated.comments[0].replies?.length, 1)
  const humanOnly = addReply(resolved, id, '复核补充')
  assert.equal(rebaseReview(resolved, humanOnly).comments[0].status, 'resolved')
  const conflicting = structuredClone(incoming)
  conflicting.comments[0].replies![0].body = '同 ID 不同内容'
  assert.throws(() => rebaseReview(first, conflicting), /回复.*冲突/)
  assert.equal(local.comments[0].replies, undefined)
})

test('merging long reply threads preserves every reply and remains idempotent', () => {
  const base = addComment(fixture(), [{ kind: 'node', id: 'check' }], '意见')
  const replied = addReply(base, base.comments[0].id, '回复')
  const reply = replied.comments[0].replies![0]
  const local = structuredClone(base)
  const incoming = structuredClone(base)
  local.comments[0].replies = Array.from({ length: 251 }, (_, index) => ({ ...reply, id: `local-${index}` }))
  incoming.comments[0].replies = Array.from({ length: 251 }, (_, index) => ({ ...reply, id: `incoming-${index}` }))
  assert.doesNotThrow(() => parseReview(local))
  assert.doesNotThrow(() => parseReview(incoming))
  const merged = rebaseReview(local, incoming)
  assert.equal(parseReview(merged).comments[0].replies?.length, 502)
  assert.equal(rebaseReview(merged, incoming).comments[0].replies?.length, 502)
  assert.equal(local.comments[0].replies.length, 251)
})

test('manual review retains the original opinion version across parsing and standalone imports', () => {
  const original = addComment(fixture(), [{ kind: 'node', id: 'check' }], 'v1 原意见')
  const next = { ...fixture(), revision: 'v2' }
  const rebased = rebaseReview(original, next)
  for (const status of ['resolved', 'open'] as const) {
    const confirmed = setCommentStatus(rebased, rebased.comments[0].id, status)
    assert.equal(confirmed.comments[0].revision, 'v1')
    assert.equal(confirmed.comments[0].reviewedRevision, 'v2')
    assert.equal(parseReview(confirmed).comments[0].status, status)
    assert.equal(rebaseReview(confirmed, next).comments[0].status, status)
    assert.equal(rebaseReview(next, parseReview(confirmed)).comments[0].status, status)
    assert.throws(() => parseReview({ ...confirmed, comments: [{ ...confirmed.comments[0], reviewedRevision: '' }] }), /人工复核版本/)
  }
  assert.equal(original.comments[0].reviewedRevision, undefined)
})
