/**
 * @agenthub/project-tool-scope —— Tool 装载 + Project 级可见性隔离 + 事件转发。
 *
 * P2 范围（P2 方案书 T6 / D2+D3 处置）：
 * - 3 个手动示例 Tool 注册到全局 Registry（§4.3）；
 * - per-Session 可见性：`scope.ctx.tools.restrict({ allow })`，allow =
 *   tools(enabled) ∩ project_tool_set（V4 隔离核心）；
 * - 上游 tools/pre|post-execute → agenthub/tool.before|after-execute 转发，
 *   audit 只订阅 agenthub 事件。
 *
 * @module @agenthub/project-tool-scope
 */
export type { SessionBinding } from './types.ts'
export {
  MANUAL_TOOL_NAMES,
  echoReadTool,
  noopWriteTool,
  noopSensitiveTool,
  registerManualTools,
} from './tools.ts'
export { ToolCatalogService, type ToolCatalog } from './loader.ts'
export { SessionToolScope, SessionToolScopeService } from './scope.ts'
export { CHAT_INTENT_TTL_MS, ChatIntents, type ChatClaim } from './chat-intent.ts'
export { resolveProjectChat, type ProjectChatResolution, type ProjectChatTarget, type UnboundReason } from './session-bind.ts'
export { installToolEventBridge, type ToolEventBridgeOptions } from './hooks.ts'
export { name, inject, apply } from './plugin.ts'
