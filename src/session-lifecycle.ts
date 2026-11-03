import type { SessionOptions } from './session-types.ts'

export function parseSessionOptions(value: { scope?: unknown; cleanupPolicy?: unknown }): SessionOptions {
  const result: SessionOptions = {}
  if (value.scope !== undefined) {
    if (!value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)) throw new Error('评审范围必须是对象')
    const scope = value.scope as Record<string, unknown>
    if (typeof scope.purpose !== 'string' || !scope.purpose.trim() || scope.purpose.length > 10000) throw new Error('请填写本次独立评审的目的，最多 10000 字符')
    if (scope.context !== undefined && (typeof scope.context !== 'string' || !scope.context.trim() || scope.context.length > 1000)) throw new Error('评审上下文须为非空文本，最多 1000 字符')
    result.scope = { purpose: scope.purpose.trim(), ...(scope.context === undefined ? {} : { context: (scope.context as string).trim() }) }
  }
  if (value.cleanupPolicy !== undefined) {
    if (value.cleanupPolicy !== 'manual' && value.cleanupPolicy !== 'archive-on-approval') throw new Error('评审清理策略无效')
    result.cleanupPolicy = value.cleanupPolicy
  }
  return result
}
