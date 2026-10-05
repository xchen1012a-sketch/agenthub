/**
 * Cordis 插件入口（P5 阶段书 §7.1-1）。
 *
 * 只依赖 `agenthub/db`（`@agenthub/auth` provide），provide `agenthub/analytics`。
 * 依赖经 `inject` 显式声明（`.ai-spec/10-architecture.md` ARCH-6），
 * 不靠配置文件里的注册顺序保证可用。
 *
 * @module @agenthub/analytics/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { createLogger, type Queryable } from '@agenthub/_shared'
import { AnalyticsService } from './service.ts'

export const name = '@agenthub/analytics' as const

export const inject = ['agenthub/db'] as const

export function apply(ctx: Context): void {
  ctx.inject(['agenthub/db'], (injected) => {
    const db = injected.get('agenthub/db') as Queryable
    ctx.provide('agenthub/analytics', new AnalyticsService(db))
    createLogger('agenthub/analytics').info(
      { event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null },
      {},
    )
  })
}
