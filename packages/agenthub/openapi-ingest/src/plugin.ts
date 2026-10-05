/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P3 方案书阶段 C T5 + P4 阶段 C3-A）。
 *
 * 只依赖 `agenthub/db`：读 `system_connections`（显式列名）与写 `tools` 草稿行；
 * Tool 的注册/执行由 `@agenthub/system-connector` 负责（职责单一）。
 *
 * `riskGrading` 开启时接上 LLM 风险分级：草稿的建议等级由模型判定，失败回落
 * `read` 并记入回执。开启却缺端点/密钥**启动即失败**——配置明确要求分级，
 * 静默降级会让人以为分级在正常工作（`.ai-spec/_index.md` ARCH-7 响亮失败）。
 *
 * @module @agenthub/openapi-ingest/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createLlmClient, createLogger, readLlmConfig, validateLlmConfig, type Queryable } from '@agenthub/_shared'
import { createLlmRiskClassifier } from './risk-classifier.ts'
import { OpenApiIngestService, type RiskClassifier } from './service.ts'
import { ScanRegistry } from './progress.ts'

export const name = '@agenthub/openapi-ingest' as const

/** 插件配置（agenthub.yaml `agenthub.openapiIngest` 段）。 */
export interface Config {
  /** 是否用 LLM 判定草稿风险等级；关闭则一律 `read`（P3 行为），且完全不调 LLM。 */
  readonly riskGrading: boolean
}

export const Config = z.object({
  /**
   * 显式必填，不给默认值：分级决定"草稿建议等级"，默认开或默认关都是替部署方
   * 做了一个安全/可用性取舍，而那不是本插件能论证的（每个默认值都要有依据）。
   * 部署方必须在 `agenthub.yaml` 里明确表态。
   */
  riskGrading: z.boolean(),
})

export const inject = ['agenthub/db'] as const

/**
 * 按配置构造分级端口。
 * @param env - 进程环境（读取 LLM 端点与密钥）。
 * @returns 分级端口；调用方已按 `riskGrading` 决定是否调用本函数。
 * @throws AgenthubError 端点/密钥不完整时（启动失败，不静默降级）。
 */
function riskClassifierOf(env: NodeJS.ProcessEnv): RiskClassifier {
  validateLlmConfig(env)
  return createLlmRiskClassifier(createLlmClient(readLlmConfig(env)))
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['agenthub/db'], (injected) => {
    const logger = createLogger('agenthub/openapi-ingest')
    const db = injected.get('agenthub/db') as Queryable
    const classifyRisk = config.riskGrading ? riskClassifierOf(process.env) : undefined
    // 扫描进度注册表随服务一起 provide：路由订阅它来给弹窗报进度。
    const progress = new ScanRegistry()
    // exactOptionalPropertyTypes：关闭分级时不传该键，而不是传 undefined。
    const options = classifyRisk === undefined ? { logger, progress } : { logger, classifyRisk, progress }
    ctx.provide('agenthub/openapi-ingest', new OpenApiIngestService(db, options))
    ctx.provide('agenthub/openapi-ingest/progress', progress)
    logger.info(
      { event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null },
      { riskGrading: classifyRisk !== undefined },
    )
  })
}
