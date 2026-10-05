/**
 * 纯类型与事件契约（无逻辑）。
 *
 * @module @agenthub/project-tool-scope/types
 */
// 事件契约统一在 @agenthub/_shared/events.ts 声明（单一声明源，勿在此重复）。

/**
 * 已打开 Session 的服务端绑定（hooks.ts 补齐身份/项目上下文用）。
 * 身份与归属在 Session 打开时由服务端写入（.ai-spec 20-security.md BND-2：模型入参不可决定）。
 */
export interface SessionBinding {
  readonly projectId: string
  readonly userId: string
  readonly sessionId: string
}
