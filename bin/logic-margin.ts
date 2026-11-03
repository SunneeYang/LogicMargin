import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ensureService } from '../server/daemon.ts'
import { parseReview } from '../src/model.ts'
import { newId } from '../src/id.ts'
import { parseRecordHistory } from '../src/workspace.ts'
import { verifyReviewSources } from './source-verification.ts'
import type { ReviewDocument, ReviewRecord } from '../src/types.ts'
import type { ReviewSession, SourceVerification } from '../src/session-types.ts'

const HELP = `LogicMargin agent review CLI

  start <review.json> [--wait]
  wait <sessionId> [--after <submissionId>] [--timeout <seconds>]
  comments <sessionId>
  get <sessionId>
  reply <sessionId> <commentId> --body-file <text-file>
  revise <sessionId> <review.json> --base-round <number> --summary <text> [--wait]
  verify <review.json> [--source-root <directory>]
  resume <sessionId> [--wait]

Options: --url <API base URL> (explicit remote service; otherwise auto-start locally)
         --public-url <review URL base> (for example a Tailscale address)
Revision: --source-root <directory> (default current working directory)
          --base-round <number> (round reviewed by the agent; obtain with wait/get)
          --unchanged-reason <text> (required when graph logic is unchanged)
          --replies-file <JSON file> (final replies published with the new graph)
Environment: LOGIC_MARGIN_URL and LOGIC_MARGIN_PUBLIC_URL supply URL defaults.

Only a browser submission completes wait. Replies never resolve comments.
JSON goes to stdout; review links and waiting status go to stderr.
`

interface IO { out(text: string): void; err(text: string): void }
interface Options {
  wait: boolean; url: string; publicUrl: string; explicitUrl: boolean; explicitPublicUrl: boolean
  after?: string; timeout?: number; bodyFile?: string; sourceRoot?: string; baseRound?: number; summary?: string; unchangedReason?: string; repliesFile?: string
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
  let wait = false
  for (let index = 0; index < args.length; index++) {
    const item = args[index]
    if (item === '--wait') { wait = true; continue }
    if (!item.startsWith('-')) { positional.push(item); continue }
    if (!['--url', '--public-url', '--after', '--timeout', '--body-file', '--source-root', '--base-round', '--summary', '--unchanged-reason', '--replies-file'].includes(item)) throw new Error(`未知参数 ${item}`)
    if (values.has(item)) throw new Error(`重复参数 ${item}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${item} 缺少值`)
    values.set(item, value)
  }
  const providedUrl = values.get('--url') ?? process.env.LOGIC_MARGIN_URL
  const providedPublicUrl = values.get('--public-url') ?? process.env.LOGIC_MARGIN_PUBLIC_URL
  const url = baseUrl(providedUrl ?? 'http://127.0.0.1:5173')
  const options: Options = { wait, url, publicUrl: baseUrl(providedPublicUrl ?? url), explicitUrl: providedUrl !== undefined, explicitPublicUrl: providedPublicUrl !== undefined }
  if (values.has('--after')) options.after = values.get('--after')
  if (values.has('--body-file')) options.bodyFile = values.get('--body-file')
  if (values.has('--source-root')) options.sourceRoot = values.get('--source-root')
  if (values.has('--summary')) options.summary = values.get('--summary')
  if (values.has('--unchanged-reason')) options.unchangedReason = values.get('--unchanged-reason')
  if (values.has('--replies-file')) options.repliesFile = values.get('--replies-file')
  if (values.has('--base-round')) {
    options.baseRound = Number(values.get('--base-round'))
    if (!Number.isSafeInteger(options.baseRound) || options.baseRound < 1 || options.baseRound > 50) throw new Error('--base-round 必须是 1 至 50 的整数')
  }
  if (values.has('--timeout')) {
    options.timeout = Number(values.get('--timeout'))
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout 必须是大于 0 的秒数')
  }
  return { positional, options }
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
  if (!Array.isArray(value) || value.length > 2000) throw new Error('发布回复必须是最多 2000 项的数组')
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

async function request(base: string, path: string, body?: unknown, timeout = 30000): Promise<ReviewSession | null> {
  const response = await fetch(`${base}/api/review-sessions${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
  })
  if (response.status === 204) return null
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : response.statusText
    throw new Error(`HTTP ${response.status}: ${message}`)
  }
  return session(payload)
}

async function requiredRequest(base: string, path: string, body?: unknown): Promise<ReviewSession> {
  const result = await request(base, path, body)
  if (!result) throw new Error('服务端未返回会话')
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
  return {
    sessionId: current.id,
    round: snapshot?.round ?? current.round,
    approved: submission.kind === 'logic-margin-approval',
    submission: { id: submission.id, kind: submission.kind, createdAt: submission.createdAt,
      review: { id: submission.review.id, title: submission.review.title, revision: submission.review.revision,
        snapshot: submission.review.snapshot, comments: submission.review.comments } },
  }
}

async function waitForSubmission(initial: ReviewSession, options: Options, io: IO) {
  let current = initial
  const deadline = options.timeout === undefined ? Infinity : Date.now() + options.timeout * 1000
  io.err(`等待本轮提交：${reviewLink(options.publicUrl, current.id)}\n`)
  while (true) {
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
      if (submission.kind === 'logic-margin-feedback') {
        await requiredRequest(options.url, `/${encodeURIComponent(current.id)}/ack`, { submissionId: submission.id })
      }
      io.out(`${JSON.stringify({ ...compactSubmission(current, submission), ...(unread.length > 1 ? {
        earlierSubmissions: unread.slice(0, -1).map(record => compactSubmission(current, record)),
      } : {}) }, null, 2)}\n`)
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('等待审查超时；会话和批注已保留，可用 resume 继续')
    try {
      const updated = await request(options.url,
        `/${encodeURIComponent(current.id)}?afterVersion=${current.version}&waitMs=${Math.min(25000, Math.ceil(remaining))}`,
        undefined, Math.min(30000, remaining))
      if (updated) current = updated
    } catch (error) {
      if (Date.now() >= deadline || (remaining <= 30000 && error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error('等待审查超时；会话和批注已保留，可用 resume 继续')
      }
      throw error
    }
  }
}

export async function runCli(args: string[], io: IO = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }, runtimeCommand = [process.execPath, fileURLToPath(new URL('./entry.ts', import.meta.url))]) {
  if (!args.length || args.includes('--help') || args[0] === 'help') { io.out(HELP); return }
  const { positional, options } = argumentsFor(args)
  const [command, id, argument] = positional
  const arity = ['reply', 'revise'].includes(command) ? 3 : 2
  if (!['start', 'wait', 'comments', 'get', 'reply', 'revise', 'resume', 'verify'].includes(command) || positional.length !== arity) {
    throw new Error('命令或参数数量无效；使用 --help 查看用法')
  }
  if (options.bodyFile && command !== 'reply') throw new Error('--body-file 仅用于 reply')
  if (options.sourceRoot && !['revise', 'verify'].includes(command)) throw new Error('--source-root 仅用于 revise 或 verify')
  if (options.baseRound !== undefined && command !== 'revise') throw new Error('--base-round 仅用于 revise')
  if (command === 'revise' && options.baseRound === undefined) throw new Error('revise 需要 --base-round <agent 实际审阅的轮次>，请从 wait 或 get 获取')
  if ((options.summary !== undefined || options.unchangedReason !== undefined || options.repliesFile !== undefined) && command !== 'revise') throw new Error('发布说明与最终回复参数仅用于 revise')
  if (command === 'revise' && (!options.summary?.trim() || options.summary.length > 10000)) throw new Error('revise 需要 --summary <本轮实际变化说明>，最多 10000 字符')
  if (options.unchangedReason !== undefined && (!options.unchangedReason.trim() || options.unchangedReason.length > 10000)) throw new Error('流程未变的原因须为非空文本，最多 10000 字符')
  if ((options.after !== undefined || options.timeout !== undefined) && command !== 'wait' && !options.wait) {
    throw new Error('--after 和 --timeout 需要 wait 命令或 --wait')
  }
  if (options.wait && !['start', 'revise', 'resume', 'wait'].includes(command)) throw new Error('此命令不支持 --wait')
  const preparedReview = command === 'start' || command === 'verify' ? await reviewFile(id) : command === 'revise' ? await reviewFile(argument) : undefined
  let source: SourceVerification | undefined
  if (command === 'revise' || command === 'verify') source = await verifyReviewSources(preparedReview!, options.sourceRoot ?? process.cwd())
  const finalReplies = options.repliesFile === undefined ? undefined : await publicationReplies(options.repliesFile)
  if (command === 'verify') { io.out(`${JSON.stringify(source, null, 2)}\n`); return }
  const service = await ensureService({ url: options.explicitUrl ? options.url : undefined, command: runtimeCommand })
  options.url = service.url
  if (!options.explicitPublicUrl) options.publicUrl = service.url
  let current: ReviewSession
  if (command === 'start') {
    current = await requiredRequest(options.url, '', { review: preparedReview })
  } else {
    current = await requiredRequest(options.url, `/${encodeURIComponent(id)}`)
  }
  const path = `/${encodeURIComponent(current.id)}`
  if (command === 'reply') {
    if (!options.bodyFile) throw new Error('reply 需要 --body-file <text-file>')
    const body = (await textFile(options.bodyFile, 40000)).trim()
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
  if (command === 'start' || command === 'revise' || command === 'resume') io.err(`审查地址：${reviewLink(options.publicUrl, current.id)}\n`)
  if (command === 'wait' || options.wait) { await waitForSubmission(current, options, io); return }
  if (command === 'get') { io.out(`${JSON.stringify(current, null, 2)}\n`); return }
  if (command === 'comments') {
    io.out(`${JSON.stringify({ sessionId: current.id, round: current.round, phase: current.phase,
      revision: current.review.revision, snapshot: current.review.snapshot, comments: current.review.comments }, null, 2)}\n`)
    return
  }
  io.out(`${JSON.stringify({ sessionId: current.id, version: current.version, round: current.round, phase: current.phase,
    url: reviewLink(options.publicUrl, current.id) }, null, 2)}\n`)
}
