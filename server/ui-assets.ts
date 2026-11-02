import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { EmbeddedAssets } from './runtime.ts'

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

export async function loadUiAssets(directory: string): Promise<EmbeddedAssets> {
  const assets: EmbeddedAssets = {}
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(join(path, entry.name), key)
      else if (entry.isFile()) assets[key] = { body: (await readFile(join(path, entry.name))).toString('base64'), type: types[extname(entry.name)] ?? 'application/octet-stream' }
    }
  }
  await visit(directory, '')
  if (!assets['/index.html']) throw new Error('缺少构建后的网页；请运行 npm run build 或使用完整安装包')
  return assets
}
