/**
 * 审批策略判定（P3 方案书 §4.4 风险策略默认 / security.md §2.1）。
 *
 * 是否送审只由 tools 表字段（requires_approval / risk_level）与配置
 * minRiskLevel 决定，不由模型或请求参数决定（fail-closed 方向：未知
 * risk_level 视为 critical）。
 *
 * @module @agenthub/approval/policy
 */

/** risk_level 全集（database-schema.md §3.4 tools 表）。 */
export const RISK_LEVELS = ['read', 'write', 'sensitive', 'critical'] as const

export type RiskLevel = (typeof RISK_LEVELS)[number]

/** 配置最小送审级别（默认 write：read 不审）。 */
export type MinRiskLevel = Exclude<RiskLevel, 'read'>

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  read: 0,
  write: 1,
  sensitive: 2,
  critical: 3,
}

/** 策略输入（来自 tools 表行；未知字段已在 catalog 侧归一）。 */
export interface ToolPolicyFacts {
  readonly requiresApproval: boolean
  readonly riskLevel: string
}

/** 判定该 Tool 调用是否需要送审。未知 risk_level 视为 critical（fail-closed）。 */
export function shouldAsk(facts: ToolPolicyFacts, minRiskLevel: MinRiskLevel): boolean {
  if (facts.requiresApproval) return true
  const level = (RISK_LEVELS as readonly string[]).includes(facts.riskLevel)
    ? facts.riskLevel as RiskLevel
    : 'critical'
  return RISK_ORDER[level] >= RISK_ORDER[minRiskLevel]
}

/** 校验配置的 minRiskLevel 合法性（failClosed 启动校验用）。 */
export function isMinRiskLevel(value: string): value is MinRiskLevel {
  return value === 'write' || value === 'sensitive' || value === 'critical'
}

/** approvals 表 risk_level CHECK 值域（database-schema.md §3.7：不含 `read`）。 */
export type ApprovalRiskLevel = Exclude<RiskLevel, 'read'>

/** 落库级别归一表：read 无对应 CHECK 值 → 取最保守的合法级别 write。 */
const APPROVAL_RISK_ORDER: Readonly<Record<RiskLevel, ApprovalRiskLevel>> = {
  read: 'write',
  write: 'write',
  sensitive: 'sensitive',
  critical: 'critical',
}

/**
 * 落库归一：`shouldAsk` 对 `requires_approval=true` 的工具一律送审（read 也送），
 * 但 approvals.risk_level 的 CHECK 不含 `read`（database-schema.md §3.7），直接落库
 * 会抛原生 PG CHECK 错误 → 上游归一 `unavailable` → 永久拒绝。故落库前归一：
 * `read → write`（最保守合法值），write/sensitive/critical 原样，未知级别按 critical
 * （同 shouldAsk 的 fail-closed 方向）。**不改送审语义**（read 仍送审）。
 */
export function toApprovalRiskLevel(riskLevel: string): ApprovalRiskLevel {
  const level = (RISK_LEVELS as readonly string[]).includes(riskLevel)
    ? riskLevel as RiskLevel
    : 'critical'
  return APPROVAL_RISK_ORDER[level]
}
