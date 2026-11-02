import { defineConfig } from 'vite'
import { createSessionApi } from './server/api.ts'
import metadata from './package.json' with { type: 'json' }

const health = (request: { url?: string }, response: import('node:http').ServerResponse, next: () => void) => {
  if (request.url?.split('?')[0] !== '/api/health') { next(); return }
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ service: 'logic-margin', apiVersion: 1, version: metadata.version, instanceId: 'development', pid: process.pid, managed: false }))
}

export default defineConfig({
  plugins: [{
    name: 'logic-margin-review-sessions',
    configureServer(server) {
      server.middlewares.use(health)
      server.middlewares.use(createSessionApi({ dataDir: process.env.LOGIC_MARGIN_DATA_DIR }))
    },
    configurePreviewServer(server) {
      server.middlewares.use(health)
      server.middlewares.use(createSessionApi({ dataDir: process.env.LOGIC_MARGIN_DATA_DIR }))
    },
  }],
})
