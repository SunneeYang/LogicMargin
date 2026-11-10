import { defineConfig } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'

const localMcp = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
  if (!request.url?.startsWith('/mcp')) { next(); return }
  const remote = request.socket.remoteAddress ?? ''
  const address = remote.replace(/^::ffff:/, '')
  if (remote === '::1' || isIP(address) === 4 && address.startsWith('127.')) { next(); return }
  // The Go backend sees the proxy's socket, so enforce the original peer here.
  response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ error: 'MCP 仅允许本机连接' }))
}

// Keep Host and Origin paired; Go enforces the same-origin boundary.
const target = process.env.LOGIC_MARGIN_GO_TARGET
const proxy = target ? { '/api': { target, changeOrigin: false }, '/mcp': { target, changeOrigin: false } } : undefined
export default defineConfig({
  plugins: [{
    name: 'logic-margin-local-mcp',
    configureServer(server) { server.middlewares.use(localMcp) },
    configurePreviewServer(server) { server.middlewares.use(localMcp) },
  }],
  server: { proxy }, preview: { proxy },
})
