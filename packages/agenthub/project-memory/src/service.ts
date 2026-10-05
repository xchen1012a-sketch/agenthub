/**
 * 项目记忆核心服务（P4 方案书阶段 A T3 / 阶段 B D33 / database-schema.md §3.6）。
 *
 * 跨 Session 项目记忆的落库与本包内检索，含会话生命周期挂钩之外的读写原语。
 *
 * 检索隔离（P4 方案书 G2 / V4）：
 * - 所有 SELECT 恒带 `WHERE project_id = $1`，跨 Project 零泄漏；
 * - 候选行（`metadata.status='candidate'`）不入检索区间（`searchTopK` / `listLocked`）；
 * - 软删行（`metadata.deleted=true`）恒不可见；
 * - 锁定项（`locked=true`）独立经 `listLocked` 全量取，不参与向量 Top-K 排序。
 *
 * 写入归属（D33）：确认 / 拒绝 / 锁定 / 软删 / 硬删一律 `WHERE id = $1 AND project_id = $2`。
 * 归属条件与写操作在同一条 SQL 内判定，跨 Project 调用命中 0 行即返回 `null` / `false`，
 * 不提供「先查归属再改写」的分离路径——分离路径会给调用方留下漏判的空间。
 *
 * 脱敏（V5）：content 落库前过 `redactText`，含 token/password/secret 键值对被替换。
 * embedding 以 number[] 传入（调用方用 llm-client 计算），服务内序列化为 pgvector 字面量。
 *
 * @module @agenthub/project-memory/service
 */
import {
  AgenthubError,
  createLogger,
  redactText,
  type Logger,
  type Queryable,
} from '@agenthub/_shared'

/** 候选状态（写入 metadata.status；缺失视为 active，向后兼容既有行）。 */
const STATUS_CANDIDATE = 'candidate'

/**
 * 向量字面量（`[1,2,3]`），INSERT / `<=>` 检索共用。
 * 列类型是 `halfvec(2048)`（迁移 0015 / D35），故调用点统一 `::halfvec` 转换——
 * 2048 维超过 pgvector `vector` 类型的索引上限（2000），不能用 `::vector`。
 */
function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/** project_memories 行（显式列名；不含 embedding，避免把向量搬进业务返回面）。 */
interface MemoryRow {
  id: string
  project_id: string
  content: string
  locked: boolean
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** 业务返回面（camelCase，embedding 不外传）。 */
export interface MemoryRecord {
  id: string
  projectId: string
  content: string
  locked: boolean
  status: 'candidate' | 'active'
  deleted: boolean
  createdAt: string
  updatedAt: string
}

/** 候选或已激活的记忆范围（`listMemories` 的过滤维度）。 */
export type MemoryScope = 'candidate' | 'active'

export interface ListMemoriesOptions {
  /** 缺省返回候选与已激活的全部未软删行。 */
  readonly scope?: MemoryScope
  /** 是否包含软删行（管理台回溯用）；缺省 false。 */
  readonly includeDeleted?: boolean
}

export interface StoreCandidateInput {
  projectId: string
  content: string
  embedding: number[]
  createdBySessionId?: string | null
}

export interface ProjectMemoryOptions {
  logger?: Logger
}

const SELECT_COLUMNS =
  'id, project_id, content, locked, metadata, created_at, updated_at'

/** 行 → 业务返回面（状态 / 软删从 metadata 派生）。 */
function mapRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    locked: row.locked,
    status: row.metadata.status === STATUS_CANDIDATE ? 'candidate' : 'active',
    deleted: row.metadata.deleted === true,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export class ProjectMemoryService {
  private readonly logger: Logger
  /**
   * 记忆集合版本号：确认候选 / 软删 / 硬删 / 拒绝候选时递增。
   * 注入侧用它判断缓存是否过期（`MemoryInjector`），避免每次 prompt 组装重复查库与
   * 重复 embedding。读取面（检索 / 列表）不改变集合，故不递增。
   */
  private memoryEpoch = 0

  constructor(
    private readonly db: Queryable,
    options: ProjectMemoryOptions = {},
  ) {
    this.logger = options.logger ?? createLogger('agenthub/project-memory')
  }

  /** 当前记忆集合版本号；变化即表示注入缓存需要重算。 */
  get listEpoch(): number {
    return this.memoryEpoch
  }

  /** 存候选（status='candidate'，不入检索）；content 落库前过 redactText（V5）。 */
  async storeCandidate(input: StoreCandidateInput): Promise<MemoryRecord> {
    const content = redactText(input.content)
    const metadata = {
      status: STATUS_CANDIDATE,
      created_by_session_id: input.createdBySessionId ?? null,
    }
    const { rows } = await this.db.query<MemoryRow>(
      'INSERT INTO project_memories (project_id, content, embedding, metadata, locked)'
      + ' VALUES ($1, $2, $3::halfvec, $4::jsonb, false)'
      + ` RETURNING ${SELECT_COLUMNS}`,
      [input.projectId, content, vectorLiteral(input.embedding), JSON.stringify(metadata)],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new AgenthubError('agenthub/project-memory/StoreFailed', '记忆候选写入未返回行')
    }
    this.logger.debug(
      { event: 'memory.candidate-stored', projectId: input.projectId, userId: null, traceId: null, sessionId: input.createdBySessionId ?? null },
      { memoryId: row.id },
    )
    return mapRow(row)
  }

  /** 确认候选 → active；非候选、不存在、或不属于该 Project 返回 null。 */
  async confirmCandidate(id: string, projectId: string): Promise<MemoryRecord | null> {
    const { rows } = await this.db.query<MemoryRow>(
      'UPDATE project_memories'
      + " SET metadata = metadata || '{\"status\":\"active\"}'::jsonb, updated_at = now()"
      + ` WHERE id = $1 AND project_id = $2 AND metadata->>'status' = '${STATUS_CANDIDATE}'`
      + ` RETURNING ${SELECT_COLUMNS}`,
      [id, projectId],
    )
    const row = rows[0]
    if (row === undefined) return null
    // 只有真正改到行才推进版本号：跨 Project 命中 0 行不改变任何注入缓存。
    this.memoryEpoch += 1
    return mapRow(row)
  }

  /** 拒绝候选：物理删候选行；非候选或跨 Project 不删，返回是否删除。 */
  async rejectCandidate(id: string, projectId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      'DELETE FROM project_memories'
      + ` WHERE id = $1 AND project_id = $2 AND metadata->>'status' = '${STATUS_CANDIDATE}' RETURNING id`,
      [id, projectId],
    )
    if (rows.length > 0) this.memoryEpoch += 1
    return rows.length > 0
  }

  /** 向量相似检索（注入用）：排除锁定项，返回 cos 距离最近的 top-K。 */
  async searchTopK(projectId: string, query: number[], k: number): Promise<MemoryRecord[]> {
    const { rows } = await this.db.query<MemoryRow>(
      `SELECT ${SELECT_COLUMNS} FROM project_memories`
      + ' WHERE project_id = $1'
      + ' AND locked = false'
      + ` AND (metadata->>'status') IS DISTINCT FROM '${STATUS_CANDIDATE}'`
      + " AND (metadata->>'deleted') IS DISTINCT FROM 'true'"
      + ' ORDER BY embedding <=> $2::halfvec'
      + ' LIMIT $3',
      [projectId, vectorLiteral(query), k],
    )
    return rows.map(mapRow)
  }

  /** 锁定项全量取（注入用：永远注入，不参与向量排序）。 */
  async listLocked(projectId: string): Promise<MemoryRecord[]> {
    const { rows } = await this.db.query<MemoryRow>(
      `SELECT ${SELECT_COLUMNS} FROM project_memories`
      + ' WHERE project_id = $1'
      + ' AND locked = true'
      + ` AND (metadata->>'status') IS DISTINCT FROM '${STATUS_CANDIDATE}'`
      + " AND (metadata->>'deleted') IS DISTINCT FROM 'true'"
      + ' ORDER BY updated_at DESC',
      [projectId],
    )
    return rows.map(mapRow)
  }

  /**
   * 管理列表（UI 用）：按范围与软删可见性过滤，恒带 project 条件。
   * @param projectId - 归属 Project；跨 Project 恒查不到行。
   * @param options - `scope` 限定候选 / 已激活；`includeDeleted` 放开软删行。
   * @returns 按 `updated_at` 倒序的行，不含 embedding。
   */
  async listMemories(projectId: string, options: ListMemoriesOptions = {}): Promise<MemoryRecord[]> {
    const conditions = ['project_id = $1']
    if (options.scope === STATUS_CANDIDATE) {
      conditions.push(`(metadata->>'status') = '${STATUS_CANDIDATE}'`)
    } else if (options.scope === 'active') {
      conditions.push(`(metadata->>'status') IS DISTINCT FROM '${STATUS_CANDIDATE}'`)
    }
    if (options.includeDeleted !== true) {
      conditions.push("(metadata->>'deleted') IS DISTINCT FROM 'true'")
    }
    const { rows } = await this.db.query<MemoryRow>(
      `SELECT ${SELECT_COLUMNS} FROM project_memories`
      + ` WHERE ${conditions.join(' AND ')}`
      + ' ORDER BY updated_at DESC',
      [projectId],
    )
    return rows.map(mapRow)
  }

  /** 待确认候选（管理台确认卡片用）。 */
  async listCandidates(projectId: string): Promise<MemoryRecord[]> {
    return this.listMemories(projectId, { scope: STATUS_CANDIDATE })
  }

  /** 锁定 / 解锁；不存在或不属于该 Project 返回 null。 */
  async setLocked(id: string, locked: boolean, projectId: string): Promise<MemoryRecord | null> {
    const { rows } = await this.db.query<MemoryRow>(
      'UPDATE project_memories SET locked = $2, updated_at = now()'
      + ` WHERE id = $1 AND project_id = $3 RETURNING ${SELECT_COLUMNS}`,
      [id, locked, projectId],
    )
    const row = rows[0]
    if (row === undefined) return null
    this.memoryEpoch += 1
    return mapRow(row)
  }

  /** 软删：metadata.deleted=true（不清表，§3.6 SHOULD）；跨 Project 不改，返回 false。 */
  async softDelete(id: string, projectId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      "UPDATE project_memories SET metadata = metadata || '{\"deleted\":true}'::jsonb, updated_at = now()"
      + ' WHERE id = $1 AND project_id = $2 RETURNING id',
      [id, projectId],
    )
    if (rows.length > 0) this.memoryEpoch += 1
    return rows.length > 0
  }

  /** 硬删：物理删行；跨 Project 不删，返回是否删除。 */
  async hardDelete(id: string, projectId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      'DELETE FROM project_memories WHERE id = $1 AND project_id = $2 RETURNING id',
      [id, projectId],
    )
    if (rows.length > 0) this.memoryEpoch += 1
    return rows.length > 0
  }
}
