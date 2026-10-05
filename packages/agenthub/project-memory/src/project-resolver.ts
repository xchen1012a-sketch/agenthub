/**
 * Session → Project 解析（P4 阶段 B 施工方案 D32 / **D34 修正**）。
 *
 * 上游 `SessionHeader` 不携带 workspace 身份，只有 `cwd`。因此归属必须由目录反查：
 *
 *   1. `workspaceRegistry.resolveByPath(cwd)` 把会话工作目录规范化并解析成 Workspace；
 *   2. 拿 Workspace id 回 `projects.harness_workspace_id`（UNIQUE）查 Project。
 *
 * **不能用目录名当 projectId**：`WorkspaceRegistry` 的 Workspace id 是创建时的
 * `randomUUID()`，与目录路径无关；目录约定只有 `<AGENTHUB_WORKSPACE_ROOT>/<projectId>`
 * 这一层，且该约定不是可查询的事实（实测：拿项目 UUID 当目录名查 `projects` 恒 0 行）。
 * 因此解析走上游公开 seam，不猜。
 *
 * 解析不出时的语义是 **不注入、不落库**（fail-closed）：认错 Project 会让记忆悄悄
 * 用在别的 Project 上，比"这次没有记忆"危险得多。
 *
 * @module @agenthub/project-memory/project-resolver
 */
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Queryable } from '@agenthub/_shared'

/** Workspace id → Project 的 SQL（`harness_workspace_id` 有 UNIQUE 约束）。 */
const SELECT_BY_WORKSPACE = 'SELECT id, name, memory_policy FROM projects WHERE harness_workspace_id = $1'

/** 解析出的 Project 归属与记忆策略。 */
export interface ResolvedProject {
  readonly projectId: string
  readonly name: string
  /** `projects.memory_policy` 原值（JSONB → 对象），缺省 `{}`。 */
  readonly memoryPolicy: Record<string, unknown>
}

interface ProjectRow {
  id: string
  name: string
  memory_policy: Record<string, unknown> | null
}

/**
 * 按 Workspace id 解析 Project。
 * @param db - 共享连接池（`agenthub/db`）。
 * @param workspaceId - 上游 Workspace id（`String(workspace.id)`）。
 * @returns 命中的 Project，或 `null`（该 Workspace 未映射到任何 Project）。
 */
export async function resolveProjectByWorkspaceId(
  db: Queryable,
  workspaceId: string,
): Promise<ResolvedProject | null> {
  const { rows } = await db.query<ProjectRow>(SELECT_BY_WORKSPACE, [workspaceId])
  const row = rows[0]
  if (row === undefined) return null
  return {
    projectId: row.id,
    name: row.name,
    memoryPolicy: row.memory_policy ?? {},
  }
}

/**
 * 由会话工作目录解析 Project 归属。
 *
 * `resolveByPath` 对不存在 / 非目录 / 未归属的路径会抛错（`realpath` 前置），
 * 这些都属于"解析不出"，统一收敛为 `null`，只留 debug 日志由调用方记录。
 *
 * @param db - 共享连接池。
 * @param registry - 上游 WorkspaceRegistry（`workspaceRegistry` seam）。
 * @param cwd - `session.header.cwd`。
 * @returns 命中的 Project；解析不出返回 `null`（调用方据此跳过，不得回退猜测）。
 */
export async function resolveProjectId(
  db: Queryable,
  registry: WorkspaceRegistry,
  cwd: string | undefined,
): Promise<ResolvedProject | null> {
  if (cwd === undefined || cwd.trim() === '') return null
  let workspaceId: string
  try {
    const workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) return null
    workspaceId = String(workspace.id)
  } catch {
    // 目录不存在 / 非目录 / realpath 失败：都是"无法归属"，不是错误路径。
    return null
  }
  return resolveProjectByWorkspaceId(db, workspaceId)
}
