/**
 * 纯类型契约（无逻辑）。
 *
 * @module @agenthub/audit/types
 */
// 事件契约统一在 @agenthub/_shared/events.ts 声明（单一声明源，勿在此重复）。

/** audit_records.status 值域（0008 CHECK；细分原因在 `result_meta.reason`，D16）。 */
export type AuditStatus = 'ok' | 'error' | 'denied' | 'pending'

/** audit_records.status 四枚举（运行时校验用；与迁移 CHECK 同步）。 */
export const STATUSES: readonly AuditStatus[] = ['ok', 'error', 'denied', 'pending']

/**
 * 审计查询条件（阶段 C3-B）。
 *
 * `projectId` **必填**：查询面恒带项目归属，调用方无法请求跨项目记录
 * （`.ai-spec/00-boundaries.md` BND-4）。
 */
export interface AuditQueryFilter {
  readonly projectId: string
  readonly userId?: string
  readonly toolId?: string
  readonly status?: AuditStatus
  /** 起始时间（含）；ISO 字符串或 Date。 */
  readonly from?: string | Date
  /** 结束时间（含）；ISO 字符串或 Date。 */
  readonly to?: string | Date
  readonly limit?: number
  readonly offset?: number
}

/** 一页审计记录（`total` 为满足同一套筛选条件的总行数，供分页计算）。 */
export interface AuditPage {
  readonly items: readonly AuditRecordRow[]
  readonly total: number
}

/** audit_records 行（.ai-spec 30-data.md DATA-1，snake_case 原样）。 */
export interface AuditRecordRow {
  id: string
  project_id: string | null
  user_id: string | null
  session_id: string | null
  tool_id: string | null
  tool_name: string
  args: unknown
  result_meta: unknown
  risk_level: string
  status: string
  trace_id: string
  created_at: Date
}
