/**
 * AgentHub 全域 branded 标识类型。
 *
 * brand 仅为编译期标记（复用上游 @deepseek-ai/dsh-brand），运行时零开销：
 * 一旦经 `as*` 助手收窄，ProjectId / UserId / SessionId 等在类型层不可互换，
 * 防止跨 Project 隔离场景下的 ID 误传（.ai-spec 00-boundaries.md BND-4）。
 *
 * @module @agenthub/_shared/types
 */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** AgentHub Project 主键（projects.id）。 */
export type ProjectId = Branded<'ProjectId'>
/** 平台用户 ID（users.id）。 */
export type UserId = Branded<'UserId'>
/** Agent 会话 ID（上游 session 或 agenthub 侧映射 ID）。 */
export type SessionId = Branded<'SessionId'>
/** Harness Workspace 标识（P1 内存版为 `mem:<uuid>`，P2 起为真实 Workspace ID）。 */
export type WorkspaceId = Branded<'WorkspaceId'>
/** 整条请求链唯一追踪 ID（与 audit_records.trace_id 同源，.ai-spec 40-extension.md EXT-8）。 */
export type TraceId = Branded<'TraceId'>

export function asProjectId(value: string): ProjectId {
  return brandString<ProjectId>(value)
}

export function asUserId(value: string): UserId {
  return brandString<UserId>(value)
}

export function asSessionId(value: string): SessionId {
  return brandString<SessionId>(value)
}

export function asWorkspaceId(value: string): WorkspaceId {
  return brandString<WorkspaceId>(value)
}

export function asTraceId(value: string): TraceId {
  return brandString<TraceId>(value)
}
