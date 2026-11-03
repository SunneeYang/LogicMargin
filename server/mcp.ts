import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CancelledNotificationSchema, isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RequestId } from '@modelcontextprotocol/sdk/types.js'

const MAX_BODY_BYTES = 11 * 1024 * 1024
const IDLE_SESSION_MS = 10 * 60 * 1000

interface Connection {
  server: McpServer
  transport: StreamableHTTPServerTransport
  responses: Set<ServerResponse>
  requests: Set<RequestId>
  idle?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}

function localRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress?.replace(/^::ffff:/, '')
  if (remote !== '::1' && !/^127(?:\.\d{1,3}){3}$/.test(remote ?? '')) return false
  const host = request.headers.host
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  try {
    const endpoint = new URL(`http://${host}`)
    if (request.headers.origin && new URL(request.headers.origin).origin !== endpoint.origin) return false
  } catch { return false }
  return true
}

function failure(request: IncomingMessage, response: ServerResponse, status: number, message: string, code = -32000) {
  request.resume()
  if (response.destroyed || response.headersSent) return
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }))
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new RangeError('MCP 请求超过 11 MB 上限')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createMcpApi(options: { version: string; configure(server: McpServer): void }) {
  const sessions = new Map<string, Connection>()
  const connections = new Set<Connection>()
  let closed = false

  function forget(connection: Connection) {
    clearTimeout(connection.idle)
    connections.delete(connection)
    if (connection.transport.sessionId) sessions.delete(connection.transport.sessionId)
  }
  function dispose(connection: Connection): Promise<void> {
    forget(connection)
    connection.closing ??= connection.server.close().finally(() => {
      for (const response of connection.responses) if (!response.writableEnded) response.destroy()
    })
    return connection.closing
  }
  function track(connection: Connection, request: IncomingMessage, response: ServerResponse, parsed: unknown) {
    clearTimeout(connection.idle)
    connection.responses.add(response)
    const ids = (Array.isArray(parsed) ? parsed : [parsed]).filter(isJSONRPCRequest).map(message => message.id)
    for (const id of ids) connection.requests.add(id)
    response.once('close', () => {
      connection.responses.delete(response)
      for (const id of ids) connection.requests.delete(id)
      if (request.method === 'POST' && !response.writableFinished) {
        // A disconnected wait cannot deliver its result; cancel it rather than leave an orphan handler.
        void dispose(connection).catch(() => {})
      } else if (connections.has(connection) && !connection.responses.size) {
        connection.idle = setTimeout(() => { void dispose(connection).catch(() => {}) }, IDLE_SESSION_MS)
        connection.idle.unref()
      }
    })
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closed) { failure(request, response, 503, 'LogicMargin 服务正在停止'); return }
    if (!localRequest(request)) { failure(request, response, 403, 'MCP 仅接受本机同源连接'); return }
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
      response.setHeader('Allow', 'GET, POST, DELETE')
      failure(request, response, 405, 'MCP 不支持此请求方法'); return
    }
    const sessionId = request.headers['mcp-session-id']
    if (Array.isArray(sessionId)) { failure(request, response, 400, 'MCP 会话标识无效'); return }
    let connection = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (sessionId !== undefined && !connection) { failure(request, response, 404, 'MCP 会话已结束，请重新连接'); return }
    let parsed: unknown
    if (request.method === 'POST') {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        failure(request, response, 415, 'MCP 请求需要 application/json'); return
      }
      if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
        failure(request, response, 413, 'MCP 请求超过 11 MB 上限'); return
      }
      try { parsed = await body(request) }
      catch (error) {
        failure(request, response, error instanceof RangeError ? 413 : 400,
          error instanceof RangeError ? error.message : 'MCP 请求 JSON 无效', error instanceof RangeError ? -32000 : -32700)
        return
      }
    }
    if (closed || response.destroyed) { failure(request, response, 503, 'LogicMargin 服务正在停止'); return }
    if (!connection) {
      if (request.method !== 'POST' || !isInitializeRequest(parsed)) {
        failure(request, response, 400, 'MCP 连接需要先初始化', -32600); return
      }
      const server = new McpServer({ name: 'logic-margin', version: options.version })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        maxRequestBodySize: MAX_BODY_BYTES,
        onsessioninitialized: id => { sessions.set(id, created) },
      })
      const created: Connection = { server, transport, responses: new Set(), requests: new Set() }
      connection = created
      transport.onclose = () => forget(created)
      connections.add(created)
      try { options.configure(server); await server.connect(transport) }
      catch (error) {
        await dispose(created)
        failure(request, response, 500, error instanceof Error ? error.message : 'MCP 启动失败'); return
      }
    }
    track(connection, request, response, parsed)
    try {
      await connection.transport.handleRequest(request, response, parsed)
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        const cancelled = CancelledNotificationSchema.safeParse(message)
        if (cancelled.success && cancelled.data.params.requestId !== undefined) connection.transport.closeSSEStream(cancelled.data.params.requestId)
      }
      if (!connection.server.server.getClientVersion()) await dispose(connection)
    } catch (error) {
      await dispose(connection)
      failure(request, response, 500, error instanceof Error ? error.message : 'MCP 连接失败')
    }
  }
  async function close(): Promise<void> {
    closed = true
    await Promise.all([...connections].map(async connection => {
      // A plain SSE EOF can leave clients waiting until their tool timeout.
      await Promise.allSettled([...connection.requests].map(id => connection.transport.send({ jsonrpc: '2.0', id,
        error: { code: -32000, message: 'LogicMargin 服务正在停止；请用 CLI 检查状态后恢复原评审' } })))
      await dispose(connection)
    }))
  }
  return { handle, close }
}
