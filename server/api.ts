import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionError, SessionStore } from './session-store.ts'
import { sendJson } from './http-response.ts'

const PREFIX = '/api/review-sessions'
const MAX_BODY_BYTES = 11 * 1024 * 1024
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new SessionError('请求需要 application/json', 415)
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new SessionError('请求超过 11 MB 上限', 413)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new SessionError('请求超过 11 MB 上限', 413)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new SessionError('请求 JSON 无效') }
}
function checkOrigin(request: IncomingMessage) {
  const origin = request.headers.origin
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new SessionError('拒绝跨站会话写入', 403)
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.headers.host) throw new Error('origin')
    } catch { throw new SessionError('拒绝跨域会话写入', 403) }
  }
}

export function createSessionApi(options: { dataDir?: string } = {}) {
  const store = new SessionStore(options.dataDir)
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const path = request.url?.split('?')[0]
    if (path !== PREFIX && !path?.startsWith(`${PREFIX}/`)) { next(); return }
    void (async () => {
      const url = new URL(request.url!, 'http://localhost')
      const view = url.searchParams.get('view') === 'current' ? 'current' : undefined
      const json = (status: number, value: unknown) => sendJson(request, response, status, value)
      if (request.method === 'POST') checkOrigin(request)
      if (path === PREFIX && request.method === 'POST') {
        const body = await readBody(request)
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('review' in body)) throw new SessionError('缺少评审流程')
        const input = body as Record<string, unknown>
        json(201, await store.create(body.review, view, { scope: input.scope, cleanupPolicy: input.cleanupPolicy, baselineReview: input.baselineReview })); return
      }
      if (path === PREFIX && request.method === 'GET') {
        json(200, await store.list({ context: url.searchParams.get('context') ?? undefined, state: url.searchParams.get('state') ?? undefined })); return
      }
      const match = path!.match(/^\/api\/review-sessions\/([^/]+)(?:\/(mutations|finish|ack|revise|cleanup|restore|archive|baseline)|\/(snapshots|records)\/([^/]+))?$/)
      if (!match) throw new SessionError('找不到此审查接口', 404)
      const [, sessionId, action, resource, resourceId] = match
      if (action === 'baseline' && request.method === 'GET') { json(200, await store.getBaseline(sessionId)); return }
      if (action === 'archive' && request.method === 'GET') { json(200, await store.getArchive(sessionId)); return }
      if (action === 'archive') throw new SessionError('此接口仅支持读取', 405)
      if (resource) {
        if (request.method !== 'GET') throw new SessionError('此接口仅支持读取', 405)
        const value = resource === 'snapshots' ? await store.getSnapshot(sessionId, Number(resourceId)) : await store.getRecord(sessionId, decodeURIComponent(resourceId))
        sendJson(request, response, 200, value); return
      }
      if (!action && request.method === 'GET') {
        if (url.searchParams.has('afterVersion')) {
          const afterVersion = Number(url.searchParams.get('afterVersion'))
          const waitMs = Number(url.searchParams.get('waitMs') ?? 25000)
          if (!Number.isSafeInteger(afterVersion) || afterVersion < 1 || !Number.isFinite(waitMs) || waitMs < 0) throw new SessionError('等待参数无效')
          const controller = new AbortController()
          const closed = () => controller.abort()
          response.on('close', closed)
          try {
            const session = await store.waitForChange(sessionId, afterVersion, Math.min(waitMs, 25000), controller.signal, view)
            if (!response.destroyed) { if (session) json(200, session); else { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end() } }
          } finally { response.off('close', closed) }
        } else json(200, await store.get(sessionId, view))
        return
      }
      if (action && request.method === 'POST') {
        const body = await readBody(request)
        if (action === 'cleanup') { json(200, await store.cleanup(sessionId, body)); return }
        if (action === 'restore') { json(200, await store.restore(sessionId, body)); return }
        if (action === 'baseline') { json(200, await store.attachBaseline(sessionId, body, view)); return }
        const session = action === 'mutations' ? await store.mutate(sessionId, body, view)
          : action === 'finish' ? await store.finish(sessionId, body, view)
          : action === 'ack' ? await store.acknowledge(sessionId, body, view)
          : await store.revise(sessionId, body, view)
        json(200, session); return
      }
      throw new SessionError('此接口不支持该方法', 405)
    })().catch(error => {
      if (response.destroyed || response.headersSent) return
      const status = error instanceof SessionError ? error.status : 400
      sendJson(request, response, status, { error: error instanceof Error ? error.message : '审查服务错误' })
    })
  }
}
