/**
 * 纯类型与 DB 行契约（无逻辑）。
 *
 * @module @agenthub/project/types
 */
import type { ProjectId, UserId, WorkspaceId } from '@agenthub/_shared'

// 事件契约统一在 @agenthub/_shared/events.ts 声明（单一声明源，勿在此重复）。

/** DB 访问面收口在 @agenthub/_shared（Queryable 单一声明，_shared/db.ts）。 */
export type { Queryable } from '@agenthub/_shared'

export type MemberRole = 'admin' | 'member' | 'approver'

/** projects 行的领域视角。 */
export interface ProjectRecord {
  readonly id: ProjectId
  readonly name: string
  readonly description: string | null
  readonly status: 'active' | 'archived'
  /** 真实 harness Workspace ID（Project ↔ Workspace 1:1，UNIQUE 约束）。 */
  readonly harnessWorkspaceId: WorkspaceId
  readonly createdBy: UserId
  readonly createdAt: string
}

/** resolveProjectContext 的产物：成员身份 + Workspace ID + Project 名。
 *
 * 字段命名 (`name` 而非 `projectName`) 因为该结构只描述"当前 Project 上下文"的视角，
 * 后续 P3 audit / P4 memory 包扩展不会与 `ProjectRecord.name` 冲突，
 * 取用方在 `createProject` 返回的 `ProjectRecord.name` 仍走原路径。
 * 解耦原则（.ai-spec 50-upstream.md UP-3）：上下文对象只为消费端服务。
 */
export interface ProjectContext {
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly role: MemberRole
  readonly name: string
}

export interface CreateProjectInput {
  readonly userId: UserId
  readonly name: string
  readonly description?: string | undefined
}

/** projects 表行（.ai-spec 30-data.md DATA-1 子集，snake_case 原样）。 */
export interface ProjectRow {
  id: string
  name: string
  description: string | null
  status: string
  harness_workspace_id: string
  created_by: string
  created_at: Date
}
