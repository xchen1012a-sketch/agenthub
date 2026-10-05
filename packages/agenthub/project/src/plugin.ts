/**
 * Cordis 插件入口（plugin-skeleton §2.1）。
 *
 * @module @agenthub/project/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { PostgresProjectRepository, type PgPool } from './repository.ts'
import { ProjectService } from './service.ts'
import { HarnessWorkspaceGateway, resolveWorkspaceRoot } from './workspace.ts'

export const name = '@agenthub/project' as const

/** 必需服务：共享 DB 连接（`agenthub/db`）+ 上游 WorkspaceRegistry。 */
export const inject = ['agenthub/db', 'workspaceRegistry'] as const

/**
 * 注册顺序（plugin-skeleton §3）：project 依赖 rbac（成员校验），必须在其后。
 * DB 连接经 §4.2 ctx.inject 声明式等待 `agenthub/db`（由 @agenthub/auth 提供），
 * 避免 fiber 并发启动时 apply 早于 provide 拿到 undefined。
 *
 * `agenthub/db` 提供的是全进程唯一 pg.Pool（_shared/db.ts 约定）；
 * pg.Pool 的结构（带 `connect()` 与 `query()`）天然契合 @agenthub/project 的 PgPool 接口。
 * Workspace 经上游 `workspaceRegistry` 公开面创建（P2 方案书 §4.2 路径约定）；
 * 该服务须在 inject 中声明，否则 cordis 拒绝 `injected.get`。
 */
export function apply(ctx: Context): void {
  ctx.inject(['agenthub/db', 'workspaceRegistry'], (injected) => {
    const pool = injected.get('agenthub/db') as PgPool
    const registry = injected.get('workspaceRegistry') as WorkspaceRegistry
    const repository = new PostgresProjectRepository(pool)
    const gateway = new HarnessWorkspaceGateway(registry)
    const service = new ProjectService(repository, gateway, (event, payload) => {
      ctx.emit(event, payload)
    }, { root: resolveWorkspaceRoot() })
    ctx.provide('agenthub/project', service)
  })
}
