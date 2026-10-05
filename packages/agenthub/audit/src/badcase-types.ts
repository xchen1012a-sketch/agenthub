/**
 * 坏例登记契约（P5 阶段书 §7.1-2）。
 *
 * @module @agenthub/audit/badcase-types
 */

/** badcases.category 八态（0012 CHECK；与迁移同步）。 */
export type BadcaseCause =
  | 'wrong_tool'
  | 'bad_param'
  | 'upstream_error'
  | 'permission_denied'
  | 'model_misunderstanding'
  | 'prompt_injection'
  | 'timeout'
  | 'unknown'

/** 运行时校验用八枚举（与迁移 CHECK 同步）。 */
export const BADCASE_CAUSES: readonly BadcaseCause[] = [
  'wrong_tool',
  'bad_param',
  'upstream_error',
  'permission_denied',
  'model_misunderstanding',
  'prompt_injection',
  'timeout',
  'unknown',
]

/** 登记一条坏例的入参。 */
export interface MarkBadcaseInput {
  /** 被判定为坏例的审计记录；必须属于 `projectId`。 */
  readonly auditId: string
  /** 归属项目（`BND-4`：写入面恒带项目归属，跨项目不得登记）。 */
  readonly projectId: string
  readonly category: BadcaseCause
  /** 判定说明（可选）。 */
  readonly note?: string | null
  /** 登记人。 */
  readonly markedBy: string
}

/** 一条坏例记录（含所挂审计记录的关键字段）。 */
export interface BadcaseRow {
  readonly id: string
  readonly audit_id: string
  readonly category: BadcaseCause
  readonly category_note: string | null
  readonly resolved: boolean
  readonly resolved_by: string | null
  readonly resolved_at: Date | string | null
  readonly created_at: Date | string
}
