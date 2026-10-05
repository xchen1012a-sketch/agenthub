/**
 * PostgreSQL 访问（迁移 0002/0003 的 users / projects / project_members 表）。
 *
 * P1 启动契约（plugin-skeleton §3 + _shared/db.ts）：
 * 全进程唯一 Pool 由 `@agenthub/auth` 创建并以 `agenthub/db` provide，
 * `@agenthub/project` 的 plugin 透传 Pool 给 Repository。
 *
 * @module @agenthub/project/repository
 */
import type { QueryResult, QueryResultRow } from 'pg'
import { asProjectId, asUserId, asWorkspaceId, type ProjectId, type UserId, type WorkspaceId } from '@agenthub/_shared'
import type { CreateProjectInput, MemberRole, ProjectRecord, ProjectRow, Queryable } from './types.ts'

/**
 * pg.Pool.connect() 产物 `PoolClient` 的最小结构子集。
 * 仅 Repository 内部 `insertProject` 事务路径使用。
 */
export interface PgPoolClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<R>, 'rows'>>
  release(): void
}

/** 可发起事务的 pg.Pool（测试用假实现替代）。 */
export interface PgPool {
  /** 直发 query（pg.Pool 自身支持）。 */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<R>, 'rows'>>
  /** 取 client 用于 BEGIN/COMMIT。 */
  connect(): Promise<PgPoolClient>
}

export class PostgresProjectRepository {
  private readonly exec: Queryable
  private readonly pool: PgPool | null

  /**
   * @param source Pool（带 `connect()`）时启用事务模式；
   *               纯 Queryable 时退化为顺序执行（单测 / 启动期 fallback）。
   *
   * 区分采用鸭子类型 `typeof source.connect === 'function'`：
   * - 测试假 Queryable 通常仅声明 `query`，落到非事务分支；
   * - pg.Pool 既有 `query` 也有 `connect`，落到事务分支。
   */
  constructor(source: Queryable | PgPool) {
    if (typeof (source as Partial<PgPool>).connect === 'function') {
      const pool = source as PgPool
      this.pool = pool
      // 直发 query 走 pool.query，不为每次读路径 connect/release。
      this.exec = pool
    } else {
      this.pool = null
      this.exec = source
    }
  }

  rowToRecord(row: ProjectRow): ProjectRecord {
    return {
      id: asProjectId(row.id),
      name: row.name,
      description: row.description,
      status: row.status === 'archived' ? 'archived' : 'active',
      harnessWorkspaceId: asWorkspaceId(row.harness_workspace_id),
      createdBy: asUserId(row.created_by),
      createdAt: row.created_at.toISOString(),
    }
  }

  /**
   * 创建 Project（P2 方案书 T4 两阶段）：
   * INSERT projects（harness_workspace_id=`pending:<projectId>` 占位，满足 UNIQUE）
   * → INSERT project_members（创建者 admin）→ 调 resolveWorkspace() 建真实
   * Workspace → UPDATE 回写 harness_workspace_id → COMMIT。
   * 任一步异常（含 Workspace 创建失败）→ ROLLBACK + release，DB 不留 pending 行。
   *
   * 事务模型（.ai-spec 30-data.md DATA-3 MUST：单数据源、原子写入）。
   * 非事务分支（无 Pool，单测形态）：按顺序执行，失败不补偿。
   */
  async insertProjectWithWorkspace(
    input: CreateProjectInput,
    projectId: ProjectId,
    resolveWorkspace: () => Promise<WorkspaceId>,
  ): Promise<ProjectRecord> {
    const pendingId = asWorkspaceId(`pending:${projectId}`)
    const pool = this.pool
    if (pool === null) {
      await this.insertProjectAndMember(input, pendingId, projectId, this.exec)
      const workspaceId = await resolveWorkspace()
      const row = await this.updateWorkspaceId(projectId, workspaceId, this.exec)
      return this.rowToRecord(row)
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await this.insertProjectAndMember(input, pendingId, projectId, client)
      const workspaceId = await resolveWorkspace()
      const row = await this.updateWorkspaceId(projectId, workspaceId, client)
      await client.query('COMMIT')
      return this.rowToRecord(row)
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // ROLLBACK 失败不掩盖原始错误；交给上层观测
      }
      throw error
    } finally {
      client.release()
    }
  }

  private async insertProjectAndMember(
    input: CreateProjectInput,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    exec: Queryable,
  ): Promise<ProjectRow> {
    const inserted = await exec.query<ProjectRow>(
      `INSERT INTO projects (id, name, description, harness_workspace_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, status, harness_workspace_id, created_by, created_at`,
      [projectId, input.name, input.description ?? null, workspaceId, input.userId],
    )
    const row = inserted.rows[0]
    if (row === undefined) {
      throw new Error('project insert returned no row')
    }
    await exec.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, \'admin\')',
      [projectId, input.userId],
    )
    return row
  }

  /** 回写真实 harness_workspace_id（两阶段第二步；WHERE id 命中 0 行视为异常）。 */
  private async updateWorkspaceId(projectId: ProjectId, workspaceId: WorkspaceId, exec: Queryable): Promise<ProjectRow> {
    const updated = await exec.query<ProjectRow>(
      `UPDATE projects SET harness_workspace_id = $2 WHERE id = $1
       RETURNING id, name, description, status, harness_workspace_id, created_by, created_at`,
      [projectId, workspaceId],
    )
    const row = updated.rows[0]
    if (row === undefined) {
      throw new Error('workspace write-back returned no row')
    }
    return row
  }

  async listByCreator(userId: UserId): Promise<ProjectRecord[]> {
    const result = await this.exec.query<ProjectRow>(
      `SELECT id, name, description, status, harness_workspace_id, created_by, created_at
       FROM projects WHERE created_by = $1 ORDER BY created_at DESC`,
      [userId],
    )
    return result.rows.map(row => this.rowToRecord(row))
  }

  async rebindWorkspace(projectId: ProjectId, workspaceId: WorkspaceId): Promise<void> {
    await this.exec.query(
      'UPDATE projects SET harness_workspace_id = $2 WHERE id = $1',
      [projectId, workspaceId],
    )
  }

  async findByWorkspaceId(workspaceId: WorkspaceId): Promise<ProjectRecord | null> {
    const result = await this.exec.query<ProjectRow>(
      `SELECT id, name, description, status, harness_workspace_id, created_by, created_at
       FROM projects WHERE harness_workspace_id = $1`,
      [workspaceId],
    )
    const row = result.rows[0]
    return row === undefined ? null : this.rowToRecord(row)
  }

  async findById(projectId: ProjectId): Promise<ProjectRecord | null> {
    const result = await this.exec.query<ProjectRow>(
      `SELECT id, name, description, status, harness_workspace_id, created_by, created_at
       FROM projects WHERE id = $1`,
      [projectId],
    )
    const row = result.rows[0]
    return row === undefined ? null : this.rowToRecord(row)
  }

  /** 成员角色查询；非成员返回 null（fail-closed 的数据源）。 */
  async memberRole(projectId: ProjectId, userId: UserId): Promise<MemberRole | null> {
    const result = await this.exec.query<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    )
    const role = result.rows[0]?.role
    return role === 'admin' || role === 'member' || role === 'approver' ? role : null
  }
}
