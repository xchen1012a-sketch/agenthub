/**
 * @agenthub/analytics —— 运营指标聚合（P5 阶段书 §7.1-1）。
 *
 * 只读服务：从 `audit_records` / `badcases` / `project_memories` / `projects`
 * 聚合 6 类指标，不写任何表、不改变任何状态。
 *
 * @module @agenthub/analytics
 */
export { AnalyticsService, parseWindow } from './service.ts'
export { name, inject, apply } from './plugin.ts'
export type {
  AnalyticsSnapshot,
  AnalyticsWindow,
  CauseCount,
  ProjectActivity,
  WindowSpec,
} from './types.ts'
