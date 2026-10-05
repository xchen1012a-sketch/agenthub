/**
 * 上游工具事件 → agenthub 命名空间事件转发（P2 方案书 T6 hooks.ts / D3 处置）。
 *
 * 监听上游真实事件 `tools/pre-execute` / `tools/post-execute`，补齐
 * userId/projectId/sessionId/riskLevel（身份取 Session 打开时的服务端绑定，
 * 不取模型入参），发 `agenthub/tool.before-execute` / `agenthub/tool.after-execute`；
 * audit 只订阅 agenthub 事件。未绑定 Project 的 Session 不发（不产生无主审计行）。
 *
 * @module @agenthub/project-tool-scope/hooks
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { AGENTHUB_EVENTS } from '@agenthub/_shared'
import type { ToolCatalog } from './loader.ts'
import type { SessionToolScopeService } from './scope.ts'

export interface ToolEventBridgeOptions {
  readonly scopes: SessionToolScopeService
  readonly catalog: ToolCatalog
  readonly now?: () => number
}

/**
 * 安装事件桥；返回合并 disposer。pre/post 均为 waterfall：必须 `next()` 透传，
 * 本包只观察不干预执行决策（deny/ask 属 P3 审批）。
 */
export function installToolEventBridge(ctx: Context, options: ToolEventBridgeOptions): () => void {
  const now = options.now ?? Date.now
  /** exec.token（每次执行唯一）→ pre 时刻，供 after 计算 durationMs。 */
  const startedAt = new Map<ToolExecutionToken, number>()

  const disposePre = ctx.on('tools/pre-execute', async (exec, next) => {
    startedAt.set(exec.token, now())
    const handle = options.scopes.bindingOf(exec.agent)
    if (handle !== null) {
      const riskLevel = await options.catalog.riskLevelOf(exec.name)
      ctx.emit(AGENTHUB_EVENTS.toolBeforeExecute, {
        toolId: exec.name,
        args: (exec.arguments ?? {}) as Record<string, unknown>,
        userId: handle.binding.userId,
        projectId: handle.binding.projectId,
        sessionId: handle.binding.sessionId,
        riskLevel: riskLevel ?? 'unknown',
      })
    }
    return next()
  })

  const disposePost = ctx.on('tools/post-execute', async (exec, result, next) => {
    const start = startedAt.get(exec.token)
    startedAt.delete(exec.token)
    const handle = options.scopes.bindingOf(exec.agent)
    if (handle !== null) {
      ctx.emit(AGENTHUB_EVENTS.toolAfterExecute, {
        toolId: exec.name,
        durationMs: start === undefined ? 0 : Math.max(0, now() - start),
        status: result.isError ? 'error' : 'ok',
        userId: handle.binding.userId,
        projectId: handle.binding.projectId,
        sessionId: handle.binding.sessionId,
      })
    }
    return next()
  })

  return () => {
    disposePre()
    disposePost()
    startedAt.clear()
  }
}
