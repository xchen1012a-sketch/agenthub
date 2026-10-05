/**
 * Cordis 插件入口：注册 GET /healthz（上游 ctx.webServer 精确路由）。
 *
 * @module @agenthub/health/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { sendJson, traceIdOf } from '@agenthub/_shared'
import { HealthService } from './service.ts'
import type { Queryable } from './db.ts'

export const name = '@agenthub/health' as const

/** 静态依赖元数据（loader 读取）；运行时以 ctx.inject 真正门禁。 */
export const inject = ['webServer', 'agenthub/db'] as const

export const HEALTHZ_PATH = '/healthz'

/** 依赖经 §4.2 ctx.inject 声明式等待（webServer + 共享 agenthub/db）。 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer', 'agenthub/db'], (injected) => {
    const webServer = injected.get('webServer') as Context['webServer']
    const db = injected.get('agenthub/db') as Queryable
    const service = new HealthService(db)
    webServer.register({
      kind: 'exact',
      path: HEALTHZ_PATH,
      handler: async (req, res) => {
        const traceId = traceIdOf(req)
        const report = await service.check(traceId)
        // V1：健康检查不要求身份（探针/负载均衡可达性优先），只读无副作用。
        sendJson(res, report.status === 'ok' ? 200 : 503, report, traceId)
      },
    })
  })
}
