/**
 * @agenthub/audit —— 审计落库。
 *
 * P2 范围（P2 方案书 T7）：订阅 `agenthub/tool.before/after-execute` 写
 * `audit_records`（pending → ok/error），args 落库前白名单脱敏（V5）；
 * trace_id 缺失时 UUIDv4 兜底。
 * P3 阶段 C T8：订阅 `agenthub/tool.denied`（denied + result_meta.reason，D16）
 * 与 `agenthub/approval.resolved`（回填 approval_id）。
 *
 * @module @agenthub/audit
 */
export type { AuditPage, AuditQueryFilter, AuditRecordRow, AuditStatus } from './types.ts'
export { STATUSES } from './types.ts'
export { BADCASE_CAUSES } from './badcase-types.ts'
export type { BadcaseCause, BadcaseRow, MarkBadcaseInput } from './badcase-types.ts'
export { AuditService, DEFAULT_AUDIT_LIMIT, type TraceIdResolver } from './service.ts'
export { name, inject, apply } from './plugin.ts'
