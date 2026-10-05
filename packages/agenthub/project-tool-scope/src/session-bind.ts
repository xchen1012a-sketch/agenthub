/**
 * 把一场新开会话绑到业务项目上。
 *
 * 工作目录必须能解析成某个项目；会话主人取自员工打开该项目对话时的登记，
 * 且仍须是该项目成员。任何一步解析不出都不绑定，不得猜一个默认项目或员工。
 *
 * @module @agenthub/project-tool-scope/session-bind
 */
import type { ChatClaim } from './chat-intent.ts'

/** 一次绑定所需的、已经由服务端解析好的身份。 */
export interface ProjectChatTarget {
  readonly projectId: string
  readonly userId: string
  readonly sessionId: string
}

/** 不绑定的原因（只用于日志）。 */
export type UnboundReason = 'no_workspace' | 'no_project' | 'no_owner' | 'ambiguous_owner' | 'not_member'

export type ProjectChatResolution =
  | { readonly bound: true; readonly target: ProjectChatTarget }
  | { readonly bound: false; readonly reason: UnboundReason; readonly projectId: string | null }

/** 解析一场会话是否属于某个业务项目。失败一律当成解析不出。 */
export async function resolveProjectChat(input: {
  readonly cwd: string | undefined
  readonly sessionId: string
  readonly resolveWorkspaceId: (cwd: string) => Promise<string | null>
  readonly findProjectId: (workspaceId: string) => Promise<string | null>
  readonly claimOwner: (projectId: string) => ChatClaim
  readonly isMember: (projectId: string, userId: string) => Promise<boolean>
}): Promise<ProjectChatResolution> {
  const cwd = input.cwd?.trim() ?? ''
  if (cwd === '') return { bound: false, reason: 'no_workspace', projectId: null }
  const workspaceId = await input.resolveWorkspaceId(cwd).catch(() => null)
  if (workspaceId === null || workspaceId === '') return { bound: false, reason: 'no_workspace', projectId: null }
  const projectId = await input.findProjectId(workspaceId).catch(() => null)
  if (projectId === null || projectId === '') return { bound: false, reason: 'no_project', projectId: null }
  const claim = input.claimOwner(projectId)
  if (claim.kind === 'none') return { bound: false, reason: 'no_owner', projectId }
  if (claim.kind === 'ambiguous') return { bound: false, reason: 'ambiguous_owner', projectId }
  const member = await input.isMember(projectId, claim.userId).catch(() => false)
  if (!member) return { bound: false, reason: 'not_member', projectId }
  return { bound: true, target: { projectId, userId: claim.userId, sessionId: input.sessionId } }
}
