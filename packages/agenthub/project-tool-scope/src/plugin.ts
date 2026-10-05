/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P2 方案书 T6）。
 *
 * @module @agenthub/project-tool-scope/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { AGENTHUB_EVENTS, asProjectId, asUserId, asWorkspaceId, createLogger, type Queryable } from '@agenthub/_shared'
import { ToolCatalogService } from './loader.ts'
import { SessionToolScopeService } from './scope.ts'
import { registerManualTools } from './tools.ts'
import { installToolEventBridge } from './hooks.ts'
import { resolveProjectChat } from './session-bind.ts'

export const name = '@agenthub/project-tool-scope' as const

/**
 * 必需服务：共享 DB 连接（@agenthub/auth provide）、Project 服务（@agenthub/project
 * provide）与上游 Tool Registry（`ctx.tools`）。project 仅用于强依赖顺序
 * （plugin-skeleton §3）：工具目录依赖 projects/project_tool_set 表，须在其后装配。
 *
 * `tools` 必须列在此处（而非仅运行时 ctx.inject）：registerManualTools /
 * SessionToolScopeService 通过闭包持有外层 ctx 并访问 `ctx.tools`，cordis 会拒绝
 * 未在 inject 中声明的服务访问。
 */
export const inject = ['agenthub/db', 'agenthub/project', 'workspaceRegistry', 'tools'] as const

/**
 * 装配流程：
 * 1. 注册 3 个手动示例 Tool 到全局 Registry（§4.3）；
 * 2. Tool 目录（tools ∩ project_tool_set）缓存服务；
 * 3. Session Tool scope 服务（per-session allow 隔离，provide `agenthub/tool-scope`）；
 * 4. 上游 tools/* 事件 → agenthub/tool.* 转发（audit 只订阅后者）；
 * 5. project.created 时失效该 Project 的目录缓存。
 */
export function apply(ctx: Context): void {
  const logger = createLogger('agenthub/project-tool-scope')
  const pool = ctx.get('agenthub/db') as Queryable
  const catalog = new ToolCatalogService(pool)
  registerManualTools(ctx)
  const scopes = new SessionToolScopeService(ctx, catalog)
  ctx.provide('agenthub/tool-scope', scopes)
  installToolEventBridge(ctx, { scopes, catalog })
  ctx.on(AGENTHUB_EVENTS.projectCreated, (payload) => {
    void catalog.refresh(payload.projectId).catch((error: unknown) => {
      logger.error(
        { event: 'tool-catalog.refresh-failed', projectId: payload.projectId, userId: null, traceId: null, sessionId: null },
        { message: error instanceof Error ? error.message : String(error) },
      )
    })
  })
  const project = ctx.get('agenthub/project') as {
    findByWorkspaceId(workspaceId: ReturnType<typeof asWorkspaceId>): Promise<{ readonly id: string } | null>
    resolveProjectContext(userId: ReturnType<typeof asUserId>, projectId: ReturnType<typeof asProjectId>): Promise<unknown>
  }
  const registry = ctx.get('workspaceRegistry') as {
    resolveByPath(path: string): Promise<{ readonly id: unknown } | undefined>
  }
  // 返回 Promise：上游在开会话的调用栈里串行等待监听器，绑定完成前会话不会开始执行 Tool。
  ctx.on('agent/created', async (payload: { agent: object }) => {
    try {
      await bindCreatedAgent(payload.agent)
    } catch (error) {
      logger.error(
        { event: 'tool-scope.open-failed', projectId: null, userId: null, traceId: null, sessionId: null },
        { message: error instanceof Error ? error.message : String(error) },
      )
    }
    return undefined
  })
  ctx.on('agent/disposed', (payload: { agent: object }) => {
    void scopes.close(payload.agent).catch((error: unknown) => {
      logger.error(
        { event: 'tool-scope.close-failed', projectId: null, userId: null, traceId: null, sessionId: null },
        { message: error instanceof Error ? error.message : String(error) },
      )
    })
  })

  /**
   * 新开的 Agent 落在业务项目工作区、且能取到打开该项目对话的员工时，打开工具身份；
   * 否则隐藏全部业务 Tool。监听器自身不抛错，避免打断开会话。
   */
  async function bindCreatedAgent(agent: object): Promise<void> {
    const session = (agent as { session?: { id?: unknown; header?: { cwd?: string } } }).session
    if (session?.id === undefined) return
    const sessionId = String(session.id)
    if (scopes.bindingOf(agent) !== null) return
    const resolution = await resolveProjectChat({
      cwd: session.header?.cwd,
      sessionId,
      claimOwner: projectId => scopes.claimChat(projectId),
      resolveWorkspaceId: async (cwd) => {
        const workspace = await registry.resolveByPath(cwd)
        return workspace === undefined ? null : String(workspace.id)
      },
      findProjectId: async (workspaceId) => {
        const record = await project.findByWorkspaceId(asWorkspaceId(workspaceId))
        return record === null ? null : record.id
      },
      isMember: async (projectId, userId) => {
        try {
          await project.resolveProjectContext(asUserId(userId), asProjectId(projectId))
          return true
        } catch {
          return false
        }
      },
    })
    if (resolution.bound) {
      await scopes.open(resolution.target.projectId, resolution.target.userId, sessionId, agent)
      return
    }
    logger.info(
      { event: 'tool-scope.unbound', projectId: resolution.projectId, userId: null, traceId: null, sessionId },
      { reason: resolution.reason },
    )
    await scopes.hide(agent, sessionId)
  }

  logger.info({ event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null }, {})
}
