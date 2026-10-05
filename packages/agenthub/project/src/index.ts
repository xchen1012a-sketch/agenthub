/**
 * @agenthub/project —— Project 领域。
 *
 * P2 范围（P2 方案书 T4/T5）：
 * - `createProject`：两阶段事务（INSERT pending → 建真实 Workspace → UPDATE
 *   回写 `harness_workspace_id`），Project ↔ Harness Workspace 1:1；
 * - `resolveProjectContext`：成员校验（fail-closed）→ ProjectContext；
 * - 创建即发 `agenthub/project.created` 事件（events-bus §2）。
 *
 * 跨 Project 严格隔离：非成员永远拿不到 Project 存在性之外的任何信息。
 *
 * @module @agenthub/project
 */
export type {
  MemberRole,
  ProjectRecord,
  ProjectContext,
  CreateProjectInput,
  ProjectRow,
  Queryable,
} from './types.ts'
export { PostgresProjectRepository, type PgPool, type PgPoolClient } from './repository.ts'
export { ProjectService } from './service.ts'
export {
  HarnessWorkspaceGateway,
  projectWorkspacePath,
  resolveWorkspaceRoot,
  type WorkspaceGateway,
} from './workspace.ts'
export { name, inject, apply } from './plugin.ts'
