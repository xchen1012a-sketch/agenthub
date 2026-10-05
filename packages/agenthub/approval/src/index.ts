/**
 * @agenthub/approval —— 审批链路闭环（P3 方案书阶段 B）。
 *
 * pre-execute 策略 ask → approval/request waterfall 落库挂起 →
 * 管理台 decide（首次决策生效，后续 409）→ 超时/孤儿 expired（deny 方向）。
 *
 * @module @agenthub/approval
 */
export { shouldAsk, isMinRiskLevel, toApprovalRiskLevel, RISK_LEVELS, type RiskLevel, type MinRiskLevel, type ApprovalRiskLevel, type ToolPolicyFacts } from './policy.ts'
export { PgApprovalToolCatalog, type ApprovalToolCatalog, type ApprovalToolRecord } from './catalog.ts'
export {
  ApprovalGateService,
  type ApprovalConfig,
  type ApprovalDecision,
  type ApprovalRecord,
  type StagedAsk,
} from './service.ts'
export { name, inject, Config, apply } from './plugin.ts'
export type { Config as ApprovalPluginConfig } from './plugin.ts'
