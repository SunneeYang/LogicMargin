import type { IncomingMessage, ServerResponse } from 'node:http'
import { gzip } from 'node:zlib'

export const COMPRESSION_THRESHOLD = 1024
const pending = new WeakSet<ServerResponse>()

export function responseEncoding(request: IncomingMessage, preferGzip = true): 'gzip' | 'identity' | null {
  const accepted = new Map<string, number>()
  for (const item of (request.headers['accept-encoding'] ?? '').split(',')) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';')
    const coding = name.trim()
    if (!coding) continue
    const parameter = parameters.map(value => value.trim()).find(value => value.startsWith('q='))
    const value = parameter?.slice(2)
    const quality = value === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0
    accepted.set(coding, Math.max(accepted.get(coding) ?? 0, quality))
  }
  const compressed = accepted.get('gzip') ?? accepted.get('*') ?? 0
  const identity = accepted.get('identity') ?? (accepted.get('*') === 0 ? 0 : 1)
  if (compressed > 0 && (identity === 0 || (preferGzip && !(accepted.has('identity') && identity > compressed)))) return 'gzip'
  if (identity > 0) return 'identity'
  return compressed > 0 ? 'gzip' : null
}

export function varyEncoding(response: ServerResponse): void {
  const current = String(response.getHeader('Vary') ?? '')
  if (!current.split(',').some(value => ['*', 'accept-encoding'].includes(value.trim().toLowerCase()))) {
    response.setHeader('Vary', current ? `${current}, Accept-Encoding` : 'Accept-Encoding')
  }
}

export function sendJson(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): void {
  if (pending.has(response) || response.headersSent || response.writableEnded || response.destroyed || request.aborted) return
  pending.add(response)
  let body: Buffer
  try { body = Buffer.from(JSON.stringify(value)) }
  catch { status = 500; body = Buffer.from('{"error":"响应序列化失败"}') }
  const send = (bytes: Buffer, encoding: 'gzip' | 'identity' | null) => {
    pending.delete(response)
    if (response.headersSent || response.writableEnded || response.destroyed || request.aborted) return
    varyEncoding(response)
    if (encoding === 'gzip') response.setHeader('Content-Encoding', 'gzip')
    else response.removeHeader('Content-Encoding')
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(request.method === 'HEAD' ? undefined : bytes)
  }
  const encoding = responseEncoding(request, body.length >= COMPRESSION_THRESHOLD)
  if (encoding === null) { status = 406; send(Buffer.alloc(0), null); return }
  if (encoding === 'identity') { send(body, encoding); return }
  const compressed = (error: Error | null, bytes?: Buffer) => {
    if (!error && bytes) send(bytes, 'gzip')
    else if (responseEncoding(request, false) === 'identity') send(body, 'identity')
    else { status = 500; send(Buffer.alloc(0), null) }
  }
  try { gzip(body, compressed) }
  catch (error) { compressed(error instanceof Error ? error : new Error('响应压缩失败')) }
}
