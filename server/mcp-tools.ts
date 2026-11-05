import { isAbsolute } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'
import { runCli } from '../bin/logic-margin.ts'

const identifier = z.string().min(1).max(200).refine(value => !!value.trim(), '标识不能为空')
const absolutePath = z.string().min(1).refine(isAbsolute, '文件和来源工作区必须使用本机绝对路径')
const text = z.string().min(1).max(10000).refine(value => !!value.trim(), '正文不能为空')
const context = z.string().min(1).max(1000).refine(value => !!value.trim(), '上下文不能为空')
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

export function registerReviewTools(server: McpServer, options: { url: () => string }): void {
  const execute = async (args: string[], signal: AbortSignal): Promise<CallToolResult> => {
    let stdout = ''
    try {
      signal.throwIfAborted()
      await runCli([...args, '--url', options.url()], { out: value => { stdout += value }, err: () => {} }, undefined,
        { signal, consumeSubmission: false })
      return { content: [{ type: 'text', text: stdout.trim() }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (stdout.trim()) {
        // Preserve a final approval even if subsequent archival or cleanup fails.
        try {
          JSON.parse(stdout)
          return { content: [{ type: 'text', text: stdout.trim() }, { type: 'text', text: `操作后续失败，以上结果仍然有效：${message}` }] }
        } catch { /* Non-JSON output isn't a completed review result. */ }
      }
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  }

  server.registerTool('start_review', {
    description: '核验本机源码并创建独立评审，立即返回会话 ID 与网页地址。随后用 wait_review 等待人工提交；不要反复调用 get_review 检查。',
    inputSchema: z.strictObject({ review_file: absolutePath, source_root: absolutePath, purpose: text,
      baseline_file: absolutePath.optional(), baseline_source_root: absolutePath.optional(), baseline_review: z.boolean().optional(),
      context: context.optional(), public_url: z.string().optional(), cleanup_on_approval: z.boolean().optional() }),
    annotations: write,
  }, ({ review_file, source_root, purpose, baseline_file, baseline_source_root, baseline_review, context, public_url, cleanup_on_approval }, { signal }) => execute([
    'start', review_file, '--source-root', source_root, '--purpose', purpose,
    ...(baseline_file === undefined ? [] : ['--baseline-file', baseline_file]),
    ...(baseline_source_root === undefined ? [] : ['--baseline-source-root', baseline_source_root]),
    ...(baseline_review ? ['--baseline-review'] : []),
    ...(context === undefined ? [] : ['--context', context]), ...(public_url === undefined ? [] : ['--public-url', public_url]),
    ...(cleanup_on_approval ? ['--cleanup-on-approval'] : []),
  ], signal))

  server.registerTool('verify_review', {
    description: '只读核验评审文件与本机源码的文件、片段摘要和快照指纹。',
    inputSchema: z.strictObject({ review_file: absolutePath, source_root: absolutePath,
      baseline_file: absolutePath.optional(), baseline_source_root: absolutePath.optional() }), annotations: readOnly,
  }, ({ review_file, source_root, baseline_file, baseline_source_root }, { signal }) => execute([
    'verify', review_file, '--source-root', source_root,
    ...(baseline_file === undefined ? [] : ['--baseline-file', baseline_file]),
    ...(baseline_source_root === undefined ? [] : ['--baseline-source-root', baseline_source_root]),
  ], signal))

  server.registerTool('attach_review_baseline', {
    description: '为缺少固定基线的原评审补入修改前流程图，先核验修改前源码，沿用 session ID 与评审轮次。已存在的基线保持固定。',
    inputSchema: z.strictObject({ session_id: identifier, baseline_file: absolutePath, source_root: absolutePath }),
    annotations: { ...write, idempotentHint: true },
  }, ({ session_id, baseline_file, source_root }, { signal }) => execute([
    'baseline', session_id, baseline_file, '--source-root', source_root,
  ], signal))

  server.registerTool('get_review', {
    description: '读取完整评审、固定提交和历史快照；可读取已归档任务。等待人工意见请使用 wait_review。',
    inputSchema: z.strictObject({ session_id: identifier }), annotations: readOnly,
  }, ({ session_id }, { signal }) => execute(['get', session_id], signal))

  server.registerTool('list_reviews', {
    description: '按 Agent 上下文和活动或归档状态查找已有评审；连接恢复后先定位原会话，避免重复创建。',
    inputSchema: z.strictObject({ context: context.optional(), state: z.enum(['active', 'archived', 'all']).optional() }), annotations: readOnly,
  }, ({ context, state }, { signal }) => execute(['list', ...(context === undefined ? [] : ['--context', context]),
    ...(state === undefined ? [] : ['--state', state])], signal))

  server.registerTool('wait_review', {
    description: '在工具内部持续等待“提交本轮”或“确认通过”，保存单条批注不会返回。after_submission 使用最后实际处理的提交 ID。返回后另用 acknowledge_review 领取反馈；通过后按清理策略调用 cleanup_review。取消或断线不会领取或归档。',
    inputSchema: z.strictObject({ session_id: identifier, after_submission: identifier.optional(),
      timeout_seconds: z.number().positive().finite().optional() }), annotations: readOnly,
  }, ({ session_id, after_submission, timeout_seconds }, { signal }) => execute(['wait', session_id,
    ...(after_submission === undefined ? [] : ['--after', after_submission]),
    ...(timeout_seconds === undefined ? [] : ['--timeout', String(timeout_seconds)])], signal))

  server.registerTool('acknowledge_review', {
    description: '在 Agent 实际读到固定反馈后标记领取。不要在 wait_review 返回之前领取；只接受当前轮最新反馈。',
    inputSchema: z.strictObject({ session_id: identifier, submission_id: identifier }),
    annotations: { ...write, idempotentHint: true },
  }, ({ session_id, submission_id }, { signal }) => execute(['ack', session_id, submission_id], signal))

  server.registerTool('reply_review', {
    description: '向原批注添加临时 Agent 回复；回复不会替人确认解决。最终回应可与 revise_review 一起发布。',
    inputSchema: z.strictObject({ session_id: identifier, comment_id: identifier, body: text }), annotations: write,
  }, ({ session_id, comment_id, body }, { signal }) => execute(['reply', session_id, comment_id, '--body', body], signal))

  server.registerTool('revise_review', {
    description: '核验当前工作区源码，按 Agent 实际处理的 base_round 发布新版流程与最终回复。逻辑未变时必须填写 unchanged_reason。',
    inputSchema: z.strictObject({ session_id: identifier, review_file: absolutePath, source_root: absolutePath,
      base_round: z.number().int().positive(), summary: text, unchanged_reason: text.optional(),
      replies_file: absolutePath.optional(), public_url: z.string().optional() }), annotations: write,
  }, ({ session_id, review_file, source_root, base_round, summary, unchanged_reason, replies_file, public_url }, { signal }) => execute([
    'revise', session_id, review_file, '--source-root', source_root, '--base-round', String(base_round), '--summary', summary,
    ...(unchanged_reason === undefined ? [] : ['--unchanged-reason', unchanged_reason]),
    ...(replies_file === undefined ? [] : ['--replies-file', replies_file]), ...(public_url === undefined ? [] : ['--public-url', public_url]),
  ], signal))

  server.registerTool('cleanup_review', {
    description: 'Agent 实际取得最终通过结果后归档评审（默认、可恢复）。永久删除或清理未完成评审须有明确用户授权。',
    inputSchema: z.strictObject({ session_id: identifier, mode: z.enum(['archive', 'delete']).optional(), force: z.boolean().optional() }),
    annotations: { ...write, destructiveHint: true },
  }, ({ session_id, mode, force }, { signal }) => execute(['cleanup', session_id, ...(mode === undefined ? [] : ['--mode', mode]),
    ...(force ? ['--force'] : [])], signal))

  server.registerTool('restore_review', {
    description: '从归档恢复同一评审，保留原会话 ID、批注和历史。',
    inputSchema: z.strictObject({ session_id: identifier }), annotations: write,
  }, ({ session_id }, { signal }) => execute(['restore', session_id], signal))
}
