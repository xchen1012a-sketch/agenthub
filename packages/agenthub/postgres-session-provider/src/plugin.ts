/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P2 方案书 T8）。
 *
 * 替换 base bundle 的 session-persistence-jsonl（agenthub.yaml overlay 中
 * 按 id 摘除）——`sessionPersistence` 服务由此改为落 PostgreSQL
 * （agenthub_sessions + agenthub_session_events，迁移 0009）。
 *
 * @module @agenthub/postgres-session-provider/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { createLogger, type Queryable } from '@agenthub/_shared'
import { PostgresSessionPersistence } from './service.ts'

export const name = '@agenthub/postgres-session-provider' as const

/** 必需服务：共享 DB 连接（由 @agenthub/auth 以 `agenthub/db` provide）。 */
export const inject = ['agenthub/db'] as const

export function apply(ctx: Context): void {
  ctx.inject(['agenthub/db'], (injected) => {
    const pool = injected.get('agenthub/db') as Queryable
    ctx.provide('sessionPersistence', new PostgresSessionPersistence(ctx, pool))
    createLogger('agenthub/session-postgres').info(
      { event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null },
      {},
    )
  })
}
