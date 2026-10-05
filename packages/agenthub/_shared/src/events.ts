/**
 * 事件总线契约（.ai-spec 40-extension.md EXT-5+EXT-6 v1 核心八事件）。
 *
 * ✅ MUST：事件名一律带 agenthub/ 前缀；一旦业务依赖不得静默改名 / 删除。
 * token-resolved 事件 ✅ MUST 禁止携带 token 明文（只带 expiresAt）。
 *
 * @module @agenthub/_shared/events
 */
// 类型面依赖：declare module 增强所在的文件必须直接 import 目标模块，
// 否则 composite 构建对孤立环境模块声明报 TS6305（产物未构建）。
import type {} from '@deepseek-ai/cordis'

export const AGENTHUB_EVENTS = {
  projectCreated: 'agenthub/project.created',
  projectDeleted: 'agenthub/project.deleted',
  userAuthenticated: 'agenthub/user.authenticated',
  externalSystemTokenRequired: 'agenthub/external-system.token-required',
  externalSystemTokenResolved: 'agenthub/external-system.token-resolved',
  toolBeforeExecute: 'agenthub/tool.before-execute',
  toolAfterExecute: 'agenthub/tool.after-execute',
  toolDenied: 'agenthub/tool.denied',
  approvalRequested: 'agenthub/approval.requested',
  approvalResolved: 'agenthub/approval.resolved',
  credentialExpired: 'agenthub/credential.expired',
  memoryCandidate: 'agenthub/memory.candidate',
} as const

export type AgenthubEventName = (typeof AGENTHUB_EVENTS)[keyof typeof AGENTHUB_EVENTS]

export interface ProjectCreatedPayload {
  projectId: string
  workspaceId: string
  createdBy: string
  name: string
}

export interface ProjectDeletedPayload {
  projectId: string
  deletedBy: string
}

export interface UserAuthenticatedPayload {
  userId: string
  sessionId: string | null
}

export interface ExternalSystemTokenRequiredPayload {
  userId: string
  systemConnectionId: string
  toolId: string
  projectId: string
}

/** ⚠️ events-bus.md MUST：禁止携带 token 明文，仅携带过期时间。 */
export interface ExternalSystemTokenResolvedPayload {
  userId: string
  systemConnectionId: string
  expiresAt: string
}

export interface ToolBeforeExecutePayload {
  toolId: string
  args: Record<string, unknown>
  userId: string
  projectId: string
  sessionId: string | null
  riskLevel: string
}

export interface ToolAfterExecutePayload {
  toolId: string
  durationMs: number
  status: 'ok' | 'error'
  userId: string
  projectId: string
  sessionId: string | null
}

/**
 * Tool 被阻断事件（P3 阶段 C T8：denied 分支细化，偏离 D10 登记为 D16）。
 *
 * 由阻断方发出（approval / system-connector），audit 订阅后把对应 pending 行
 * 置 `status='denied'` 并把语义写入 `result_meta.reason`——
 * `audit_records.status` CHECK 只收四枚举，细分原因不得写进 status 列。
 *
 * reason 取值约定（闭集；与实际可达取值保持一致）：
 * - `denied:no_approver`：failClosed=true 且该 Project 无审批人；
 * - `denied:credential_missing`：未绑定凭证；
 * - `denied:credential_expired`：凭证过期；
 * - `denied:tool_disabled`：Tool 已禁用（重载窗口内旧注册被调用）；
 * - `denied:origin_mismatch`：connector Tool 目标域与连接 base_url 异源（凭证不外发）；
 * - `denied:upstream_403`：外部系统返回 403；
 * - `denied:approval_rejected` / `denied:approval_expired`：人工拒绝 / 审批超时。
 */
export interface ToolDeniedPayload {
  /** 工具名（与 ToolBeforeExecutePayload.toolId 同源，供 audit 关联 pending 行）。 */
  toolId: string
  projectId: string
  userId: string
  sessionId: string | null
  /** `denied:<原因>` 语义串（见本接口注释闭集）。 */
  reason: string
}

export interface ApprovalRequestedPayload {
  approvalId: string
  toolId: string
  riskLevel: string
  args: Record<string, unknown>
  projectId: string
  requestedBy: string
}

/** status 仅终态三值（pending 不发 resolved）。 */
export interface ApprovalResolvedPayload {
  approvalId: string
  toolId: string
  projectId: string
  status: 'approved' | 'rejected' | 'expired'
  approverId: string | null
  decidedAt: string
  reason: string | null
}

/** ⚠️ 同 token-resolved MUST：禁止携带凭证明文，仅携带过期时间。 */
export interface CredentialExpiredPayload {
  userId: string
  systemConnectionId: string
  expiredAt: string
}

/**
 * 记忆候挑选事件（P4 方案书阶段 B T4 / P4 阶段 B 施工方案 §6）。
 *
 * 会话结束后提取器落库候选，通知管理台刷新「候选记忆」卡片。
 * payload 只给身份与计数：**不含 embedding 向量、不含记忆正文、不含凭证明文**
 * （.ai-spec 20-security.md BND-1：`ctx.emit()` payload 属禁止出现明文凭证的位置）。
 */
export interface MemoryCandidatePayload {
  /** 候选归属 Project。 */
  projectId: string
  /** 产出候选的会话 id。 */
  sessionId: string
  /** 本次落库的候选条数。 */
  count: number
}

/** 事件名 → Payload 类型映射（ctx.on 侧按事件名收敛 Payload 类型）。 */
export interface AgenthubEventPayloads {
  [AGENTHUB_EVENTS.projectCreated]: ProjectCreatedPayload
  [AGENTHUB_EVENTS.projectDeleted]: ProjectDeletedPayload
  [AGENTHUB_EVENTS.userAuthenticated]: UserAuthenticatedPayload
  [AGENTHUB_EVENTS.externalSystemTokenRequired]: ExternalSystemTokenRequiredPayload
  [AGENTHUB_EVENTS.externalSystemTokenResolved]: ExternalSystemTokenResolvedPayload
  [AGENTHUB_EVENTS.toolBeforeExecute]: ToolBeforeExecutePayload
  [AGENTHUB_EVENTS.toolAfterExecute]: ToolAfterExecutePayload
  [AGENTHUB_EVENTS.toolDenied]: ToolDeniedPayload
  [AGENTHUB_EVENTS.approvalRequested]: ApprovalRequestedPayload
  [AGENTHUB_EVENTS.approvalResolved]: ApprovalResolvedPayload
  [AGENTHUB_EVENTS.credentialExpired]: CredentialExpiredPayload
  [AGENTHUB_EVENTS.memoryCandidate]: MemoryCandidatePayload
}

export type AgenthubEventPayload<K extends AgenthubEventName> = AgenthubEventPayloads[K]

/**
 * Cordis 事件面的唯一声明源：全部 agenthub 事件在此并入宿主 Events，
 * 发出方（project / project-tool-scope）与订阅方（audit 等）不再各自 declare module
 * ——同签名重复声明会触发 oxlint 对无关上游文件 emit 断言的误报，严禁回退到分散声明。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agenthub/project.created'(payload: ProjectCreatedPayload): void
    'agenthub/project.deleted'(payload: ProjectDeletedPayload): void
    'agenthub/user.authenticated'(payload: UserAuthenticatedPayload): void
    'agenthub/external-system.token-required'(payload: ExternalSystemTokenRequiredPayload): void
    'agenthub/external-system.token-resolved'(payload: ExternalSystemTokenResolvedPayload): void
    'agenthub/tool.before-execute'(payload: ToolBeforeExecutePayload): void
    'agenthub/tool.after-execute'(payload: ToolAfterExecutePayload): void
    'agenthub/tool.denied'(payload: ToolDeniedPayload): void
    'agenthub/approval.requested'(payload: ApprovalRequestedPayload): void
    'agenthub/approval.resolved'(payload: ApprovalResolvedPayload): void
    'agenthub/credential.expired'(payload: CredentialExpiredPayload): void
    'agenthub/memory.candidate'(payload: MemoryCandidatePayload): void
  }
}
