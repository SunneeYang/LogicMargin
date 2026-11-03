import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ensureService } from '../server/daemon.ts'
import { parseReview } from '../src/model.ts'
import { newId } from '../src/id.ts'
import { parseRecordHistory } from '../src/workspace.ts'
import { parseSessionOptions } from '../src/session-lifecycle.ts'
import { verifyReviewSources } from './source-verification.ts'
import type { ReviewDocument, ReviewRecord } from '../src/types.ts'
import type { ReviewSession, SourceVerification } from '../src/session-types.ts'

const HELP = `LogicMargin agent review CLI

  start <review.json> [--wait]
  wait <sessionId> [--after <submissionId>] [--timeout <seconds>]
  comments <sessionId>
  get <sessionId>
  reply <sessionId> <commentId> --body-file <text-file>
  ack <sessionId> <submissionId>
  revise <sessionId> <review.json> --base-round <number> --summary <text> [--wait]
  verify <review.json> [--source-root <directory>]
  resume <sessionId> [--wait]
  list [--context <thread/workflow>] [--state active|archived|all]
  cleanup <sessionId> [--mode archive|delete] [--force]
  restore <sessionId>

Options: --url <API base URL> (explicit remote service; otherwise auto-start locally)
         --public-url <review URL base> (for example a Tailscale address)
New review: --context <thread/workflow> --purpose <review purpose>
            --cleanup-on-approval (archive after the agent receives approval)
Waiting: --cleanup-on-approval also enables archival for this wait/resume call.
Sources: --source-root <directory> (verify/start/revise; default current working directory)
Reply: --body <text> may replace --body-file.
Revision:
          --base-round <number> (round reviewed by the agent; obtain with wait/get)
          --unchanged-reason <text> (required when graph logic is unchanged)
          --replies-file <JSON file> (final replies published with the new graph)
Environment: LOGIC_MARGIN_URL and LOGIC_MARGIN_PUBLIC_URL supply URL defaults.

Only a browser submission completes wait. Replies never resolve comments.
JSON goes to stdout; review links and waiting status go to stderr.
`

interface IO { out(text: string): void; err(text: string): void }
interface ExecutionOptions { signal?: AbortSignal; consumeSubmission?: boolean }
interface Options {
  wait: boolean; url: string; publicUrl: string; explicitUrl: boolean; explicitPublicUrl: boolean
  after?: string; timeout?: number; bodyFile?: string; body?: string; sourceRoot?: string; baseRound?: number; summary?: string; unchangedReason?: string; repliesFile?: string
  context?: string; purpose?: string; cleanupOnApproval: boolean; force: boolean; mode?: 'archive' | 'delete'; state?: 'active' | 'archived' | 'all'
}

function baseUrl(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('URL 必须是无认证信息、查询参数或片段的 HTTP(S) 地址')
  }
  return url.toString().replace(/\/$/, '')
}

function argumentsFor(args: string[]) {
  const positional: string[] = []
  const values = new Map<string, string>()
  let wait = false, cleanupOnApproval = false, force = false, help = false
  for (let index = 0; index < args.length; index++) {
    const item = args[index]
    if (item === '--help') { help = true; continue }
    if (item === '--wait') { wait = true; continue }
    if (item === '--cleanup-on-approval') { cleanupOnApproval = true; continue }
    if (item === '--force') { force = true; continue }
    if (!item.startsWith('-')) { positional.push(item); continue }
    if (!['--url', '--public-url', '--after', '--timeout', '--body-file', '--body', '--source-root', '--base-round', '--summary', '--unchanged-reason', '--replies-file', '--context', '--purpose', '--mode', '--state'].includes(item)) throw new Error(`未知参数 ${item}`)
    if (values.has(item)) throw new Error(`重复参数 ${item}`)
    const value = args[++index]
    if (!value || (item !== '--body' && value.startsWith('--'))) throw new Error(`${item} 缺少值`)
    values.set(item, value)
  }
  const providedUrl = values.get('--url') ?? process.env.LOGIC_MARGIN_URL
  const providedPublicUrl = values.get('--public-url') ?? process.env.LOGIC_MARGIN_PUBLIC_URL
  const url = baseUrl(providedUrl ?? 'http://127.0.0.1:5173')
  const options: Options = { wait, cleanupOnApproval, force, url, publicUrl: baseUrl(providedPublicUrl ?? url), explicitUrl: providedUrl !== undefined, explicitPublicUrl: providedPublicUrl !== undefined }
  if (values.has('--after')) options.after = values.get('--after')
  if (values.has('--body-file')) options.bodyFile = values.get('--body-file')
  if (values.has('--body')) options.body = values.get('--body')
  if (values.has('--source-root')) options.sourceRoot = values.get('--source-root')
  if (values.has('--summary')) options.summary = values.get('--summary')
  if (values.has('--unchanged-reason')) options.unchangedReason = values.get('--unchanged-reason')
  if (values.has('--replies-file')) options.repliesFile = values.get('--replies-file')
  for (const option of ['context', 'purpose'] as const) {
    const value = values.get(`--${option}`)
    if (value !== undefined) options[option] = value
  }
  if (options.context !== undefined || options.purpose !== undefined) {
    const checked = parseSessionOptions({ scope: { purpose: options.purpose ?? '评审', context: options.context } }).scope!
    if (options.context !== undefined) options.context = checked.context
    if (options.purpose !== undefined) options.purpose = checked.purpose
  }
  const mode = values.get('--mode')
  if (mode !== undefined) {
    if (mode !== 'archive' && mode !== 'delete') throw new Error('--mode 必须是 archive 或 delete')
    options.mode = mode
  }
  const state = values.get('--state')
  if (state !== undefined) {
    if (!['active', 'archived', 'all'].includes(state)) throw new Error('--state 必须是 active、archived 或 all')
    options.state = state as Options['state']
  }
  if (values.has('--base-round')) {
    options.baseRound = Number(values.get('--base-round'))
    if (!Number.isSafeInteger(options.baseRound) || options.baseRound < 1) throw new Error('--base-round 必须是正整数')
  }
  if (values.has('--timeout')) {
    options.timeout = Number(values.get('--timeout'))
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout 必须是大于 0 的秒数')
  }
  return { positional, options, help }
}

async function textFile(path: string, maxBytes: number): Promise<string> {
  if ((await stat(path)).size > maxBytes) throw new Error(`文件过大：${path}`)
  const body = await readFile(path, 'utf8')
  if (Buffer.byteLength(body) > maxBytes) throw new Error(`文件过大：${path}`)
  return body
}

async function reviewFile(path: string): Promise<ReviewDocument> {
  return parseReview(JSON.parse(await textFile(path, 10 * 1024 * 1024)))
}

async function publicationReplies(path: string): Promise<{ commentId: string; body: string }[]> {
  const value: unknown = JSON.parse(await textFile(path, 10 * 1024 * 1024))
  if (!Array.isArray(value)) throw new Error('发布回复必须是数组')
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.commentId !== 'string' || !item.commentId.trim() || item.commentId.length > 200 ||
      typeof item.body !== 'string' || !item.body.trim() || item.body.length > 10000) throw new Error('发布回复须包含有效的 commentId 与非空正文，正文最多 10000 字符')
    return { commentId: item.commentId, body: item.body }
  })
}

function session(value: unknown): ReviewSession {
  if (!value || typeof value !== 'object') throw new Error('服务端返回了无效会话')
  const result = value as ReviewSession
  if (result.schemaVersion !== 1 || typeof result.id !== 'string' || !result.id ||
    !Number.isSafeInteger(result.version) || result.version < 1 || !Number.isSafeInteger(result.round) || result.round < 1 ||
    !['awaiting-review', 'feedback-ready', 'agent-working', 'approved'].includes(result.phase) ||
    !Array.isArray(result.snapshots) || typeof result.createdAt !== 'string' || typeof result.updatedAt !== 'string' ||
    (result.acknowledgedSubmission !== undefined && typeof result.acknowledgedSubmission !== 'string')) throw new Error('服务端返回了无效会话')
  result.review = parseReview(result.review)
  result.history = parseRecordHistory(result.history)
  Object.assign(result, parseSessionOptions(result))
  for (const snapshot of result.snapshots) {
    if (!snapshot || !Number.isSafeInteger(snapshot.round) || snapshot.round < 1 || !Number.isFinite(Date.parse(snapshot.openedAt))) {
      throw new Error('服务端返回了无效轮次快照')
    }
    if (snapshot.afterSubmission !== undefined && !result.history.some(record => record.id === snapshot.afterSubmission)) {
      throw new Error('服务端返回了无效轮次提交边界')
    }
    snapshot.review = parseReview(snapshot.review)
  }
  return result
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(`HTTP ${status}: ${message}`); this.status = status }
}

async function requestPayload(base: string, path: string, body?: unknown, timeout = 30000, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${base}/api/review-sessions${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(timeout))), ...(signal ? [signal] : [])]),
  })
  if (response.status === 204) return null
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : response.statusText
    throw new HttpError(response.status, message)
  }
  return payload
}

async function request(base: string, path: string, body?: unknown, timeout = 30000, signal?: AbortSignal): Promise<ReviewSession | null> {
  const value = await requestPayload(base, path, body, timeout, signal)
  return value === null ? null : session(value)
}

async function requiredRequest(base: string, path: string, body?: unknown): Promise<ReviewSession> {
  const result = await request(base, path, body)
  if (!result) throw new Error('服务端未返回会话')
  return result
}

async function activeOrArchived(base: string, path: string): Promise<ReviewSession> {
  try { return await requiredRequest(base, path) }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 410) throw error
    return requiredRequest(base, `${path}/archive`)
  }
}

async function cleanup(base: string, current: ReviewSession, mode: 'archive' | 'delete', force = false) {
  const result = await requestPayload(base, `/${encodeURIComponent(current.id)}/cleanup`, {
    expectedVersion: current.version, mode, ...(force ? { allowUnfinished: true } : {}),
  })
  if (!result || typeof result !== 'object' || !('id' in result) || result.id !== current.id || !('mode' in result) || result.mode !== mode) {
    throw new Error('服务端返回了无效清理结果')
  }
  return result
}

function reviewLink(base: string, id: string): string {
  const url = new URL(`${base}/`)
  url.searchParams.set('session', id)
  return url.toString()
}

function compactSubmission(current: ReviewSession, submission: ReviewRecord) {
  const submissionIndex = current.history.findIndex(item => item.id === submission.id)
  const snapshot = [...current.snapshots].reverse().find(item => submissionIndex >
    (item.afterSubmission === undefined ? -1 : current.history.findIndex(record => record.id === item.afterSubmission)))
  const approved = submission.kind === 'logic-margin-approval'
  const source = submission.review.snapshot
  return {
    sessionId: current.id,
    ...(current.scope === undefined ? {} : { scope: current.scope }),
    ...(current.cleanupPolicy === undefined ? {} : { cleanupPolicy: current.cleanupPolicy }),
    round: snapshot?.round ?? current.round,
    approved,
    submission: { id: submission.id, kind: submission.kind, createdAt: submission.createdAt,
      review: { id: submission.review.id, title: submission.review.title, revision: submission.review.revision,
        ...(approved ? {
          snapshot: { repository: source.repository, commit: source.commit, fingerprint: source.fingerprint,
            capturedAt: source.capturedAt, dirty: source.dirty },
          resolvedCommentCount: submission.review.comments.length,
        } : { snapshot: source, comments: submission.review.comments }) } },
  }
}

async function waitForSubmission(initial: ReviewSession, options: Options, io: IO, execution: ExecutionOptions = {}) {
  let current = initial
  const deadline = options.timeout === undefined ? Infinity : Date.now() + options.timeout * 1000
  io.err(`等待本轮提交：${reviewLink(options.publicUrl, current.id)}\n`)
  while (true) {
    execution.signal?.throwIfAborted()
    const boundary = current.snapshots.at(-1)?.afterSubmission
    const acknowledged = current.acknowledgedSubmission
    const boundaryIndex = current.history.findIndex(record => record.id === boundary)
    const acknowledgedIndex = current.history.findIndex(record => record.id === acknowledged)
    const after = options.after ?? (boundaryIndex > acknowledgedIndex ? boundary : acknowledged)
    const cursor = after === undefined ? -1 : current.history.findIndex(record => record.id === after)
    if (after !== undefined && cursor < 0) throw new Error(`找不到提交游标 ${after}；请用 get 核对会话历史`)
    const unread = current.history.slice(cursor + 1)
    const submission = unread.at(-1)
    if (submission) {
        if (submission.kind === 'logic-margin-feedback' && execution.consumeSubmission !== false) {
        await requiredRequest(options.url, `/${encodeURIComponent(current.id)}/ack`, { submissionId: submission.id })
      }
      const result = compactSubmission(current, submission)
        io.out(`${JSON.stringify({ ...result,
          ...(execution.consumeSubmission === false && submission.kind === 'logic-margin-feedback' ? { requiresAcknowledgement: true } : {}),
          ...(execution.consumeSubmission === false && submission.kind === 'logic-margin-approval' && (options.cleanupOnApproval || current.cleanupPolicy === 'archive-on-approval') ? { cleanupPending: true } : {}),
          ...(unread.length > 1 ? result.approved
            ? { earlierSubmissionIds: unread.slice(0, -1).map(record => record.id) }
            : { earlierSubmissions: unread.slice(0, -1).map(record => compactSubmission(current, record)) }
            : {}) }, null, 2)}\n`)
        if (execution.consumeSubmission !== false && submission.kind === 'logic-margin-approval' && (options.cleanupOnApproval || current.cleanupPolicy === 'archive-on-approval')) {
        if (current.phase !== 'approved' || result.round !== current.round || submission.review.revision !== current.review.revision ||
          submission.review.snapshot.fingerprint !== current.review.snapshot.fingerprint) {
          io.err('通过记录不属于当前已通过轮次，保留会话并跳过自动归档。\n')
          return
        }
        try {
          await cleanup(options.url, current, 'archive')
          io.err(`评审已归档，可用 restore ${current.id} 恢复。\n`)
        } catch (error) { throw new Error(`已输出通过结果，但自动归档失败；会话数据已保留：${error instanceof Error ? error.message : String(error)}`) }
      }
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('等待审查超时；会话和批注已保留，可用 resume 继续')
    try {
      const updated = await request(options.url,
        `/${encodeURIComponent(current.id)}?afterVersion=${current.version}&waitMs=${Math.min(25000, Math.ceil(remaining))}`,
          undefined, Math.min(30000, remaining), execution.signal)
      if (updated) current = updated
    } catch (error) {
      if (Date.now() >= deadline || (remaining <= 30000 && error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error('等待审查超时；会话和批注已保留，可用 resume 继续')
      }
      throw error
    }
  }
}

export async function runCli(args: string[], io: IO = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }, runtimeCommand = [process.execPath, fileURLToPath(new URL('./entry.ts', import.meta.url))], execution: ExecutionOptions = {}) {
  execution.signal?.throwIfAborted()
  if (!args.length || args[0] === 'help') { io.out(HELP); return }
  const { positional, options, help } = argumentsFor(args)
  if (help) { io.out(HELP); return }
  const [command, id, argument] = positional
  const arity = command === 'list' ? 1 : ['reply', 'revise', 'ack'].includes(command) ? 3 : 2
  if (!['start', 'wait', 'comments', 'get', 'reply', 'revise', 'resume', 'verify', 'list', 'cleanup', 'restore', 'ack'].includes(command) || positional.length !== arity) {
    throw new Error('命令或参数数量无效；使用 --help 查看用法')
  }
  if ((options.bodyFile || options.body !== undefined) && command !== 'reply') throw new Error('--body-file 和 --body 仅用于 reply')
  if (options.bodyFile && options.body !== undefined) throw new Error('--body-file 与 --body 不能同时使用')
  if (options.sourceRoot && !['start', 'revise', 'verify'].includes(command)) throw new Error('--source-root 仅用于 start、revise 或 verify')
  if (options.baseRound !== undefined && command !== 'revise') throw new Error('--base-round 仅用于 revise')
  if (command === 'revise' && options.baseRound === undefined) throw new Error('revise 需要 --base-round <agent 实际审阅的轮次>，请从 wait 或 get 获取')
  if ((options.summary !== undefined || options.unchangedReason !== undefined || options.repliesFile !== undefined) && command !== 'revise') throw new Error('发布说明与最终回复参数仅用于 revise')
  if (command === 'revise' && (!options.summary?.trim() || options.summary.length > 10000)) throw new Error('revise 需要 --summary <本轮实际变化说明>，最多 10000 字符')
  if (options.unchangedReason !== undefined && (!options.unchangedReason.trim() || options.unchangedReason.length > 10000)) throw new Error('流程未变的原因须为非空文本，最多 10000 字符')
  if ((options.after !== undefined || options.timeout !== undefined) && command !== 'wait' && !options.wait) {
    throw new Error('--after 和 --timeout 需要 wait 命令或 --wait')
  }
  if (options.wait && !['start', 'revise', 'resume', 'wait'].includes(command)) throw new Error('此命令不支持 --wait')
  if (options.context !== undefined && !['start', 'list'].includes(command)) throw new Error('--context 仅用于 start 或 list')
  if (options.purpose !== undefined && command !== 'start') throw new Error('--purpose 仅用于 start')
  if (options.state !== undefined && command !== 'list') throw new Error('--state 仅用于 list')
  if ((options.mode !== undefined || options.force) && command !== 'cleanup') throw new Error('--mode 和 --force 仅用于 cleanup')
  if (options.cleanupOnApproval && !['start', 'wait', 'resume'].includes(command)) throw new Error('--cleanup-on-approval 仅用于 start、wait 或 resume')
  if (options.cleanupOnApproval && command === 'resume' && !options.wait) throw new Error('resume 的 --cleanup-on-approval 需要 --wait')
  const preparedReview = command === 'start' || command === 'verify' ? await reviewFile(id) : command === 'revise' ? await reviewFile(argument) : undefined
  let source: SourceVerification | undefined
  if (command === 'revise' || command === 'verify' || (command === 'start' && options.sourceRoot)) source = await verifyReviewSources(preparedReview!, options.sourceRoot ?? process.cwd())
  const finalReplies = options.repliesFile === undefined ? undefined : await publicationReplies(options.repliesFile)
  if (command === 'verify') { io.out(`${JSON.stringify(source, null, 2)}\n`); return }
  execution.signal?.throwIfAborted()
  const service = await ensureService({ url: options.explicitUrl ? options.url : undefined, command: runtimeCommand })
  options.url = service.url
  if (!options.explicitPublicUrl) options.publicUrl = service.url
  if (command === 'list') {
    const query = new URLSearchParams({ state: options.state ?? 'active', ...(options.context === undefined ? {} : { context: options.context }) })
    const result = await requestPayload(options.url, `?${query}`)
    if (!result || typeof result !== 'object' || !('sessions' in result) || !Array.isArray(result.sessions) ||
      result.sessions.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.title !== 'string' || !Number.isSafeInteger(item.version))) {
      throw new Error('服务端返回了无效会话列表')
    }
    io.out(`${JSON.stringify(result, null, 2)}\n`); return
  }
  let current: ReviewSession
  if (command === 'start') {
    const isolated = options.context !== undefined || options.purpose !== undefined
    const scope = isolated ? parseSessionOptions({ scope: { purpose: options.purpose ?? (preparedReview!.description.trim() || preparedReview!.title),
      ...(options.context === undefined ? {} : { context: options.context }) } }).scope : undefined
    current = await requiredRequest(options.url, '', { review: isolated ? { ...preparedReview!, comments: [] } : preparedReview,
      ...(scope === undefined ? {} : { scope }), ...(options.cleanupOnApproval ? { cleanupPolicy: 'archive-on-approval' } : {}) })
  } else if (command === 'restore') {
    current = await requiredRequest(options.url, `/${encodeURIComponent(id)}/archive`)
  } else if (command === 'get' || command === 'cleanup') {
    current = await activeOrArchived(options.url, `/${encodeURIComponent(id)}`)
  } else {
    current = await requiredRequest(options.url, `/${encodeURIComponent(id)}`)
  }
  const path = `/${encodeURIComponent(current.id)}`
  execution.signal?.throwIfAborted()
  if (command === 'ack') {
    current = await requiredRequest(options.url, `${path}/ack`, { submissionId: argument })
  }
  if (command === 'cleanup') {
    io.out(`${JSON.stringify(await cleanup(options.url, current, options.mode ?? 'archive', options.force), null, 2)}\n`); return
  }
  if (command === 'restore') {
    current = await requiredRequest(options.url, `${path}/restore`, { expectedVersion: current.version })
  }
  if (command === 'reply') {
    if (!options.bodyFile && options.body === undefined) throw new Error('reply 需要 --body-file <text-file> 或 --body <text>')
    const body = (options.body ?? await textFile(options.bodyFile!, 40000)).trim()
    if (!body || body.length > 10000) throw new Error('回复须为非空文本，最多 10000 字符')
    if (!current.review.comments.some(comment => comment.id === argument)) throw new Error(`批注不存在：${argument}`)
    const reply = { id: newId(), author: 'agent', body, createdAt: new Date().toISOString(), revision: current.review.revision }
    current = await requiredRequest(options.url, `${path}/mutations`, {
      round: current.round, revision: current.review.revision, fingerprint: current.review.snapshot.fingerprint,
      mutations: [{ kind: 'add-reply', commentId: argument, reply }],
    })
  }
  if (command === 'revise') {
    if (options.baseRound !== current.round) throw new Error(`发布基于第 ${options.baseRound} 轮，但会话已是第 ${current.round} 轮；请用 get 核对新版后重新修改`)
    const review = { ...preparedReview!, snapshot: { ...preparedReview!.snapshot, files: source!.files } }
    if (review.id !== current.review.id) throw new Error('新版评审必须沿用原评审 ID')
    const publication = { baseRound: options.baseRound, summary: options.summary!.trim(), source: source!,
      ...(options.unchangedReason === undefined ? {} : { unchangedReason: options.unchangedReason.trim() }) }
    current = await requiredRequest(options.url, `${path}/revise`, { expectedVersion: current.version, review, publication,
      ...(finalReplies === undefined ? {} : { replies: finalReplies }) })
  }
  if (['start', 'revise', 'resume', 'restore'].includes(command)) io.err(`审查地址：${reviewLink(options.publicUrl, current.id)}\n`)
  if (command === 'wait' || options.wait) { await waitForSubmission(current, options, io, execution); return }
  if (command === 'get') { io.out(`${JSON.stringify(current, null, 2)}\n`); return }
  if (command === 'comments') {
    io.out(`${JSON.stringify({ sessionId: current.id, round: current.round, phase: current.phase, ...(current.scope === undefined ? {} : { scope: current.scope }),
      revision: current.review.revision, snapshot: current.review.snapshot, comments: current.review.comments }, null, 2)}\n`)
    return
  }
  io.out(`${JSON.stringify({ sessionId: current.id, version: current.version, round: current.round, phase: current.phase,
    ...(current.scope === undefined ? {} : { scope: current.scope }), ...(current.cleanupPolicy === undefined ? {} : { cleanupPolicy: current.cleanupPolicy }),
    url: reviewLink(options.publicUrl, current.id) }, null, 2)}\n`)
}
