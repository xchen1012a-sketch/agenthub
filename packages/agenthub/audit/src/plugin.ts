/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P2 方案书 T7）。
 *
 * @module @agenthub/audit/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { AGENTHUB_EVENTS, createLogger, getTraceId, type Queryable, type TraceIdSource } from '@agenthub/_shared'
import { AuditService } from './service.ts'

export const name = '@agenthub/audit' as const

/** 必需服务：共享 DB 连接（由 @agenthub/auth 以 `agenthub/db` provide）。 */
export const inject = ['agenthub/db'] as const

/**
 * 注册顺序（plugin-skeleton §3）：audit 订阅 `agenthub/tool.*`（发出方为
 * project-tool-scope / system-connector）、`agenthub/tool.denied`（approval /
 * system-connector）与 `agenthub/approval.resolved`（approval），必须在
 * project-tool-scope 与 approval 之后装配。订阅失败只记日志，不阻断工具执行
 * （audit 是旁路观察者）。
 */
export function apply(ctx: Context): void {
  ctx.inject(['agenthub/db'], (injected) => {
    const logger = createLogger('agenthub/audit')
    const pool = injected.get('agenthub/db') as Queryable
    // 断言为最小读取面 TraceIdSource：auth 中间件 provide(TRACE_ID_KEY) 后即可读。
    const service = new AuditService(pool, () => getTraceId(ctx as Context & TraceIdSource))
    ctx.on(AGENTHUB_EVENTS.toolBeforeExecute, (payload) => {
      void service.recordBeforeExecute(payload).catch((error: unknown) => {
        logger.error(
          { event: 'audit.before-failed', projectId: payload.projectId, userId: payload.userId, traceId: null, sessionId: payload.sessionId },
          { message: error instanceof Error ? error.message : String(error) },
        )
      })
    })
    ctx.on(AGENTHUB_EVENTS.toolAfterExecute, (payload) => {
      void service.recordAfterExecute(payload).catch((error: unknown) => {
        logger.error(
          { event: 'audit.after-failed', projectId: payload.projectId, userId: payload.userId, traceId: null, sessionId: payload.sessionId },
          { message: error instanceof Error ? error.message : String(error) },
        )
      })
    })
    // T8：阻断事件 → denied + result_meta.reason（D16）。
    ctx.on(AGENTHUB_EVENTS.toolDenied, (payload) => {
      void service.recordDenied(payload).catch((error: unknown) => {
        logger.error(
          { event: 'audit.denied-failed', projectId: payload.projectId, userId: payload.userId, traceId: null, sessionId: payload.sessionId },
          { message: error instanceof Error ? error.message : String(error) },
        )
      })
    })
    // T8：审批结算 → 回填 approval_id。
    ctx.on(AGENTHUB_EVENTS.approvalResolved, (payload) => {
      void service.recordApprovalResolved(payload).catch((error: unknown) => {
        logger.error(
          { event: 'audit.approval-link-failed', projectId: payload.projectId, userId: null, traceId: null, sessionId: null },
          { message: error instanceof Error ? error.message : String(error) },
        )
      })
    })
    ctx.provide('agenthub/audit', service)
    logger.info({ event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null }, {})
  })
}
