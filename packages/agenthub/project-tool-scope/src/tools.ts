/**
 * 3 个手动示例 Tool（P2 方案书 §4.3，对应 0007 迁移种子行）。
 *
 * 注册写法遵循 S3 结论：上游公开 `ctx.tools.register()`，不碰 packages/tool 内部。
 * 定义结构与上游 scoped.spec.ts 先例一致（原生 ToolDefinition 字面量）。
 * `noop_sensitive` 参数含 token/password/secret 字面量，作为 V5 脱敏测试固定夹具。
 *
 * @module @agenthub/project-tool-scope/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 种子 Tool 名清单（与 0007 迁移种子一一对应；loader 按 `tools.name` 关联）。 */
export const MANUAL_TOOL_NAMES = ['echo_read', 'noop_write', 'noop_sensitive'] as const

export type ManualToolName = (typeof MANUAL_TOOL_NAMES)[number]

/** 必填字符串参数校验（原生 ToolDefinition 的参数校验由 tool 自身负责）。 */
function requireString(args: unknown, field: string, toolName: string): string {
  const value = (args as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${toolName}: 参数 ${field} 必填且为非空字符串`)
  }
  return value
}

/** echo_read：原样返回输入参数（risk_level=read）。 */
export function echoReadTool(): ToolDefinition {
  return {
    name: 'echo_read',
    description: '原样返回输入参数的只读示例工具',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的文本' } },
      required: ['message'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const message = (value as { message?: string }).message
        return [{ type: 'text', text: `echo: ${message ?? ''}` }]
      },
    },
    execute: (args) => {
      requireString(args, 'message', 'echo_read')
      return Promise.resolve(args)
    },
  }
}

/** noop_write：无副作用，模拟写操作（risk_level=write）。 */
export function noopWriteTool(): ToolDefinition {
  return {
    name: 'noop_write',
    description: '无副作用的写入示例工具（P2 无审批流，requires_approval 留待 P3 启用）',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: '模拟写入目标' } },
      required: ['target'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const target = (value as { target?: string }).target
        return [{ type: 'text', text: `noop_write: 已模拟写入 ${target ?? ''}` }]
      },
    },
    execute: (args) => {
      const target = requireString(args, 'target', 'noop_write')
      return Promise.resolve({ ok: true, target })
    },
  }
}

/** noop_sensitive：参数可携带敏感字段，用于验证审计脱敏（risk_level=sensitive）。 */
export function noopSensitiveTool(): ToolDefinition {
  return {
    name: 'noop_sensitive',
    description: '参数含敏感字段名的示例工具，用于验证审计脱敏（V5）',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询内容' },
        token: { type: 'string', description: '将被脱敏的字段' },
        password: { type: 'string', description: '将被脱敏的字段' },
        secret: { type: 'string', description: '将被脱敏的字段' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const query = (value as { query?: string }).query
        return [{ type: 'text', text: `noop_sensitive: ${query ?? ''}` }]
      },
    },
    execute: (args) => {
      const query = requireString(args, 'query', 'noop_sensitive')
      return Promise.resolve({ ok: true, query })
    },
  }
}

/** 注册 3 个手动示例 Tool；返回合并 disposer（解除全部注册）。 */
export function registerManualTools(ctx: Context): () => void {
  const disposers = [echoReadTool(), noopWriteTool(), noopSensitiveTool()].map(definition =>
    ctx.tools.register(definition),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
