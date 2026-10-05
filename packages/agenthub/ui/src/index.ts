/**
 * @agenthub/ui —— AgentHub 页面（P1 占位形态，P4 换Slots + 完整 React UI）。
 *
 * 阶段书 §3.1 #11：登录占位页 + Project 列表页 + Project 详情空壳；
 * 路径约定 U2（plugin-skeleton §6）：/agenthub/login、/agenthub/projects、/agenthub/projects/<id>。
 * i18n（U4）：en / zh 双语同步。
 *
 * @module @agenthub/ui
 */
export { pickLocale, t, MESSAGES, type Locale, type Messages } from './i18n.ts'
export {
  layout,
  loginPage,
  projectsPage,
  projectDetailPage,
  sessionsPage,
  errorPage,
  escapeHtml,
} from './render.ts'
export { handleAgenthubRequest, type RouterDeps, type RouteRequest, type RouteResult } from './router.ts'
export {
  handleAgenthubApi,
  type ApiDeps,
  type JsonApiDeps,
  type ToolRecord,
  type ToolRisk,
  type ToolStatus,
  type ConnectionHealthRecord,
  type AnalyticsRecord,
  type AnalyticsKpi,
  type BadcaseRecord,
  type BadcaseCause,
  type UserRecord,
  type RoleRecord,
  type ProjectOption,
  type MemoryRecord,
  type MemoryLike,
  type AuditRecord,
  type AuditLike,
  type AuditStatus,
  type SystemConnectionLike,
  type ConnectorLike,
  type VaultLike,
  type IngestLike,
} from './api.ts'
export { name, apply, inject } from './plugin.ts'
