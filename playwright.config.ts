import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: {
    command: 'node scripts/go-e2e-server.mjs',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120000,
  },
})
