import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { startNativeServer } from './native.js'

export const name = 'logic-margin'
export const inject = ['tools', 'skills']
export const Config = z.object({
  home: z.string().description('Optional absolute LogicMargin service home; omit to reuse the normal shared service.'),
  port: z.number().step(1).min(0).max(65535).description('Optional local service port; 0 selects an available port for an isolated service.'),
})

export async function apply(ctx, config = {}) {
  const startup = new AbortController()
  ctx.effect(() => () => startup.abort(new Error('LogicMargin plugin unloaded')))
  const resources = fileURLToPath(new URL('./resources/logic-margin/', import.meta.url))
  const { mcpUrl } = await startNativeServer(resources, config, startup.signal, scrubbedParentEnv())
  await ctx.plugin(McpClient, {
    serverName: 'logic_margin', transport: 'streamable-http', url: mcpUrl,
    toolCallTimeoutMs: 86_400_000, failOnStartupError: true,
  })
  await ctx.plugin(SkillFilesystem, {
    providerName: 'logic-margin-bundled', includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('./resources/logic-margin/skills/', import.meta.url)), watch: false,
  })
  // The daemon is shared with other hosts; unloading this plugin only withdraws its MCP and skill.
}
