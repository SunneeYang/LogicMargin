import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { createSessionApi } from './api.ts'
import { COMPRESSION_THRESHOLD, responseEncoding, sendJson, varyEncoding } from './http-response.ts'
import { createMcpApi } from './mcp.ts'
import { registerReviewTools } from './mcp-tools.ts'

export type EmbeddedAssets = Record<string, { body: string; type: string }>

function pathname(request: IncomingMessage) {
  const path = decodeURIComponent((request.url ?? '').split('?')[0])
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('请求路径无效')
  }
  return path
}

function sameOrigin(request: IncomingMessage) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === request.headers.host
  } catch { return false }
}

export async function createReviewServer(options: {
  assets: EmbeddedAssets
  dataDir: string
  host?: string
  port?: number
  instanceId: string
  version: string
  shutdownToken: string
}): Promise<{ url: string; close(): Promise<void>; closed: Promise<void> }> {
  if (!options.shutdownToken || !options.instanceId || !options.version) throw new Error('服务身份与关闭令牌不能为空')
  const compress = promisify(gzip)
  const assets = new Map(await Promise.all(Object.entries(options.assets).map(async ([path, asset]) => {
    const body = Buffer.from(asset.body, 'base64')
    return [path, { body, gzip: await compress(body), type: asset.type }] as const
  })))
  if (!assets.has('/index.html')) throw new Error('程序未包含网页入口，请重新打包')
  const api = createSessionApi({ dataDir: options.dataDir })
  let url = ''
  const mcp = createMcpApi({ version: options.version, configure: server => registerReviewTools(server, { url: () => url }) })
  const polls = new Map<ServerResponse, IncomingMessage>()
  let closing: Promise<void> | undefined
  const server = createServer((request, response) => {
    if (closing) { sendJson(request, response, 503, { error: 'LogicMargin 正在停止，请用 CLI 检查服务后重新连接 MCP' }); return }
    let path: string
    try { path = pathname(request) }
    catch { sendJson(request, response, 400, { error: '请求路径无效' }); return }
    if (path === '/mcp') {
      void mcp.handle(request, response).catch(error => {
        if (!response.headersSent && !response.destroyed) sendJson(request, response, 500, { error: error instanceof Error ? error.message : 'MCP 服务错误' })
        else response.destroy()
      })
      return
    }
    if (path === '/api/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); sendJson(request, response, 405, { error: '此接口仅支持读取' }); return }
      sendJson(request, response, 200, { service: 'logic-margin', apiVersion: 1, version: options.version, instanceId: options.instanceId, pid: process.pid, managed: true, mcp: true })
      return
    }
    if (path === '/api/shutdown') {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); sendJson(request, response, 405, { error: '关闭服务需要 POST' }); return }
      if (!sameOrigin(request) || request.headers['x-logic-margin-token'] !== options.shutdownToken) { sendJson(request, response, 403, { error: '关闭服务未获授权' }); return }
      request.resume()
      response.setHeader('Connection', 'close')
      response.once('finish', () => { void close() })
      sendJson(request, response, 200, { stopped: true })
      return
    }
    if (path === '/api' || path.startsWith('/api/')) {
      if (request.method === 'GET' && new URL(request.url!, 'http://localhost').searchParams.has('afterVersion')) {
        polls.set(response, request)
        response.once('close', () => polls.delete(response))
      }
      api(request, response, () => sendJson(request, response, 404, { error: '找不到此审查接口' }))
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); sendJson(request, response, 405, { error: '网页仅支持 GET 或 HEAD' }); return }
    const asset = assets.get(path === '/' ? '/index.html' : path) ?? (!path.split('/').at(-1)?.includes('.') ? assets.get('/index.html') : undefined)
    if (!asset) { sendJson(request, response, 404, { error: '找不到此资源' }); return }
    varyEncoding(response)
    const encoding = responseEncoding(request, asset.body.length >= COMPRESSION_THRESHOLD)
    if (!encoding) { sendJson(request, response, 406, { error: '没有可接受的响应编码' }); return }
    const body = encoding === 'gzip' ? asset.gzip : asset.body
    if (encoding === 'gzip') response.setHeader('Content-Encoding', 'gzip')
    response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' })
    response.end(request.method === 'HEAD' ? undefined : body)
  })
  const closed = new Promise<void>(resolve => { server.once('close', () => resolve()) })
  function close() {
    closing ??= (async () => {
      for (const [response, request] of polls) if (!response.headersSent) sendJson(request, response, 503, { error: '服务正在停止，请恢复会话后重试' })
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      try { await mcp.close() }
      finally { server.closeAllConnections(); await stopped }
    })()
    return closing
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { await close(); throw new Error('无法确定服务监听地址') }
  const host = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host ?? '127.0.0.1'
  url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`
  return { url, close, closed }
}
