/**
 * 审计落库服务（P2 方案书 T7 / P3 阶段 C T8 / .ai-spec 30-data.md DATA-1）。
 *
 * before-execute 写 pending 行（args 白名单脱敏），after-execute 回写
 * status / result_meta（.ai-spec 20-security.md SEC-1：落库前必须过 _shared/redact，
 * 禁止正则）；trace_id 从请求 ctx（TRACE_ID_KEY）透传，缺失时 UUIDv4 兜底。
 * 未在 tools 表登记的 Tool risk_level 按 critical 记（.ai-spec 20-security.md BND-3 默认拒绝）。
 *
 * T8 补两条链路：
 * - `tool.denied` → 对应 pending 行置 `status='denied'`，细分原因写 `result_meta.reason`
 *   （`audit_records.status` CHECK 只收四枚举，不得把 `denied:xxx` 写进 status 列，D16）；
 * - `approval.resolved` → 回填 `audit_records.approval_id`（按 Project + Tool 关联最近一行）。
 *
 * @module @agenthub/audit/service
 */
import {
  AgenthubError,
  createLogger,
  createTraceId,
  redactArgs,
  type ApprovalResolvedPayload,
  type Logger,
  type Queryable,
  type ToolAfterExecutePayload,
  type ToolBeforeExecutePayload,
  type ToolDeniedPayload,
  type TraceId,
} from '@agenthub/_shared'
import { STATUSES, type AuditPage, type AuditQueryFilter, type AuditRecordRow } from './types.ts'
import { BADCASE_CAUSES, type BadcaseRow, type MarkBadcaseInput } from './badcase-types.ts'

/** 单页默认条数（审计页 50/页）。 */
export const DEFAULT_AUDIT_LIMIT = 50

/** traceId 解析注入点：P2 工具执行尚不挂请求上下文，插件接 getTraceId(ctx)；null 时 UUIDv4 兜底。 */
export type TraceIdResolver = () => TraceId | null

/** before / after / denied 三类事件的公共关联字段。 */
interface CorrelationFields {
  readonly toolId: string
  readonly projectId: string
  readonly userId: string
  readonly sessionId: string | null
}

/** pending 行关联键（同一 (项目, 用户, 会话, 工具) 的 before/after/denied 归并为一行）。 */
function correlationKey(payload: CorrelationFields): string {
  return `${payload.projectId}|${payload.userId}|${payload.sessionId ?? ''}|${payload.toolId}`
}

export class AuditService {
  private readonly logger: Logger
  /**
   * correlationKey → pending 行 id 的解析 promise。
   *
   * C-6：`before-execute` 的 listener 未 await，`tool.denied`（同步发出）可能先于
   * before 落库到达。此处在**任何 await 之前同步占位**，使 denied / after 能等到
   * 同一 pending 行 id，保证 before → denied/after 顺序一致（不再永停 pending）。
   */
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(
    private readonly db: Queryable,
    private readonly resolveTraceId: TraceIdResolver,
  ) {
    this.logger = createLogger('agenthub/audit')
  }

  /**
   * before-execute：查 tools.id / risk_level → 写 pending 行（args 已脱敏）。
   * 先同步占位再落库（C-6）。
   */
  async recordBeforeExecute(payload: ToolBeforeExecutePayload): Promise<void> {
    const key = correlationKey(payload)
    if (this.pending.has(key)) {
      // 同键重复 before（上一轮未回写 after）：旧行保持 pending，新事件另起一行。
      this.pending.delete(key)
    }
    const task = this.insertPending(payload)
    this.pending.set(key, task)
    try {
      const id = await task
      if (id === null) this.pending.delete(key)
    } catch (error) {
      this.pending.delete(key)
      throw error
    }
  }

  /** 落库 pending 行并返回其 id（脱敏 args）；供 recordBeforeExecute 占位复用。 */
  private async insertPending(payload: ToolBeforeExecutePayload): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string; risk_level: string }>(
      'SELECT id, risk_level FROM tools WHERE name = $1',
      [payload.toolId],
    )
    const tool = rows[0]
    const traceId = this.resolveTraceId() ?? createTraceId()
    // ✅ MUST（.ai-spec 20-security.md SEC-1）：args 落库前「白名单 + 黑名单」双重过滤（禁正则）。
    const argsRedacted = redactArgs(payload.args)
    const { rows: inserted } = await this.db.query<{ id: string }>(
      'INSERT INTO audit_records'
      + ' (project_id, user_id, session_id, tool_id, tool_name, args, risk_level, status, trace_id)'
      + ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [
        payload.projectId,
        payload.userId,
        payload.sessionId,
        tool?.id ?? null,
        payload.toolId,
        JSON.stringify(argsRedacted),
        // CHECK 约束只收四枚举；未登记 Tool 按 critical（fail-closed 方向）。
        tool !== undefined ? tool.risk_level : 'critical',
        'pending',
        traceId,
      ],
    )
    this.logger.debug(
      { event: 'audit.pending', projectId: payload.projectId, userId: payload.userId, traceId, sessionId: payload.sessionId },
      { toolName: payload.toolId, riskLevel: tool?.risk_level ?? 'critical' },
    )
    return inserted[0]?.id ?? null
  }

  /** after-execute：回写 status 与 result_meta（durationMs）；无 pending 行时记日志跳过。 */
  async recordAfterExecute(payload: ToolAfterExecutePayload): Promise<void> {
    const key = correlationKey(payload)
    const task = this.pending.get(key)
    if (task === undefined) {
      this.logger.warn(
        { event: 'audit.after-orphan', projectId: payload.projectId, userId: payload.userId, traceId: null, sessionId: payload.sessionId },
        { toolName: payload.toolId },
      )
      return
    }
    this.pending.delete(key)
    const id = await task
    if (id === null) return
    await this.db.query(
      'UPDATE audit_records SET status = $2, result_meta = $3 WHERE id = $1',
      [id, payload.status, JSON.stringify({ durationMs: payload.durationMs })],
    )
  }

  /**
   * tool.denied（T8 / D16）：对应 pending 行置 `status='denied'`，细分原因写
   * `result_meta.reason`（`denied:no_approver` / `denied:credential_missing` /
   * `denied:credential_expired` / `denied:upstream_403` / `denied:approval_rejected` /
   * `denied:approval_expired`）。无 pending 行时记日志跳过（旁路观察者不阻断）。
   */
  async recordDenied(payload: ToolDeniedPayload): Promise<void> {
    const key = correlationKey(payload)
    const task = this.pending.get(key)
    if (task === undefined) {
      this.logger.warn(
        { event: 'audit.denied-orphan', projectId: payload.projectId, userId: payload.userId, traceId: null, sessionId: payload.sessionId },
        { toolName: payload.toolId, reason: payload.reason },
      )
      return
    }
    this.pending.delete(key)
    const id = await task
    if (id === null) return
    await this.db.query(
      'UPDATE audit_records SET status = $2, result_meta = $3 WHERE id = $1',
      [id, 'denied', JSON.stringify({ reason: payload.reason })],
    )
    this.logger.debug(
      { event: 'audit.denied', projectId: payload.projectId, userId: payload.userId, traceId: null, sessionId: payload.sessionId },
      { toolName: payload.toolId, reason: payload.reason },
    )
  }

  /**
   * approval.resolved（T8）：回填 `audit_records.approval_id`。
   *
   * `approval.resolved` 不携带用户 / 会话，故按 **Project + Tool（tools.id UUID）**
   * 关联该组合下最近一行审计记录；不限制 status，使 approve（随后写 ok）/ reject /
   * expire（随后写 denied）三种时序都能命中同一行。
   */
  async recordApprovalResolved(payload: ApprovalResolvedPayload): Promise<void> {
    await this.db.query(
      'UPDATE audit_records SET approval_id = $1'
      + ' WHERE id = (SELECT id FROM audit_records WHERE project_id = $2 AND tool_id = $3 ORDER BY created_at DESC LIMIT 1)',
      [payload.approvalId, payload.projectId, payload.toolId],
    )
    this.logger.debug(
      { event: 'audit.approval-linked', projectId: payload.projectId, userId: null, traceId: null, sessionId: null },
      { approvalId: payload.approvalId, status: payload.status },
    )
  }

  /** 当前 pending 行数（测试与运维观察用）。 */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * 分页查询审计记录（阶段 C3-B）。
   *
   * 查询面**恒带 project 归属**（`BND-4`）：调用方给不出要跨项目的入口。
   * 计数与取数共用同一套 WHERE 与参数，只有取数多绑定 `LIMIT` / `OFFSET`，
   * 保证 `total` 与 `items` 永远是同一筛选条件下的结果。
   * @param filter - 查询条件（`from` / `to` 均为闭区间）。
   * @returns 该条件下的一页记录与总行数。
   * @throws Error `status` 不在四枚举内时（非法值不得静默当默认）。
   */
  async listRecords(filter: AuditQueryFilter): Promise<AuditPage> {
    const { projectId, userId, toolId, status, from, to, limit = DEFAULT_AUDIT_LIMIT, offset = 0 } = filter
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
      // 用 AgenthubError 而非裸 Error：调用方（路由 / 后续消费者）拿到的是同一套错误契约。
      throw new AgenthubError('agenthub/audit/InvalidStatus', `audit status 非法：${status}`, { httpStatus: 400 })
    }
    const values: unknown[] = [projectId]
    const conditions = ['project_id = $1']
    // 条件与占位符同步增长，避免手写序号错位。
    const add = (column: string, value: unknown, cast = ''): void => {
      values.push(value)
      conditions.push(`${column} = $${String(values.length)}${cast}`)
    }
    if (userId !== undefined) add('user_id', userId)
    if (toolId !== undefined) add('tool_id', toolId)
    if (status !== undefined) add('status', status)
    if (from !== undefined) {
      values.push(from)
      conditions.push(`created_at >= $${String(values.length)}::timestamptz`)
    }
    if (to !== undefined) {
      values.push(to)
      conditions.push(`created_at <= $${String(values.length)}::timestamptz`)
    }
    const where = conditions.join(' AND ')

    const counted = await this.db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM audit_records WHERE ${where}`,
      values,
    )
    const { rows } = await this.db.query<AuditRecordRow>(
      'SELECT id, project_id, user_id, session_id, tool_id, tool_name, args, result_meta,'
      + ` risk_level, status, trace_id, created_at FROM audit_records WHERE ${where}`
      + ` ORDER BY created_at DESC LIMIT $${String(values.length + 1)}::int OFFSET $${String(values.length + 2)}::int`,
      [...values, limit, offset],
    )
    return { items: rows, total: Number(counted.rows[0]?.total ?? '0') }
  }

  /**
   * 登记一条坏例（P5 阶段书 §7.1-2）。
   *
   * 先校验该审计记录属于 `projectId`（`BND-4`：写入面恒带项目归属，调用方
   * 给不出跨项目入口），再以 `audit_id` 为冲突键 **upsert**；重复登记更新既有
   * 判定并清空销号状态，不产生第二行。
   * @param input - 审计记录、项目归属、归因与登记人。
   * @returns 落库后的坏例行。
   * @throws AgenthubError `category` 非法（400）、或审计记录不属该项目（404）。
   */
  async markBadcase(input: MarkBadcaseInput): Promise<BadcaseRow> {
    const { auditId, projectId, category, note = null } = input
    if (!(BADCASE_CAUSES as readonly string[]).includes(category)) {
      throw new AgenthubError('agenthub/audit/InvalidCategory', `坏例归因非法：${category}`, { httpStatus: 400 })
    }

    const owned = await this.db.query<{ id: string }>(
      'SELECT id FROM audit_records WHERE id = $1::uuid AND project_id = $2::uuid',
      [auditId, projectId],
    )
    if (owned.rows.length === 0) {
      throw new AgenthubError(
        'agenthub/audit/AuditNotFound',
        '审计记录不存在或不属于该项目',
        { httpStatus: 404 },
      )
    }

    const { rows } = await this.db.query<BadcaseRow>(
      'INSERT INTO badcases (audit_id, category, category_note, resolved, resolved_by, resolved_at)'
      + ' VALUES ($1::uuid, $2, $3, FALSE, NULL, NULL)'
      + ' ON CONFLICT (audit_id) DO UPDATE SET'
      + ' category = EXCLUDED.category, category_note = EXCLUDED.category_note,'
      + ' resolved = FALSE, resolved_by = NULL, resolved_at = NULL'
      + ' RETURNING id, audit_id, category, category_note, resolved, resolved_by, resolved_at, created_at',
      [auditId, category, note],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new AgenthubError('agenthub/audit/BadcaseWriteFailed', '坏例登记未返回行', { httpStatus: 500 })
    }
    return row
  }

  /**
   * 查一条坏例的归属项目。
   *
   * 存在的意义是让调用方（路由）能**先取归属、再做成员校验**：客户端不必知道
   * 坏例属于哪个项目，权限判定仍由服务端完成，不给跨项目入口。
   * @param badcaseId - 坏例 id。
   * @returns 所属项目 id；坏例不存在时为 `null`。
   */
  async findBadcaseProject(badcaseId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ project_id: string | null }>(
      'SELECT a.project_id FROM badcases b JOIN audit_records a ON a.id = b.audit_id'
      + ' WHERE b.id = $1::uuid',
      [badcaseId],
    )
    return rows[0]?.project_id ?? null
  }

  /**
   * 坏例销号（P5 阶段书 §7.1-2）。
   *
   * 仅当坏例所挂审计记录属于 `projectId` 时生效；已销号行不再改动
   * （保留首次销号人与时间）。查不到或跨项目 → `null`，不区分"不存在"与
   * "无权限"，避免泄漏他项目坏例的存在性。
   * @param badcaseId - 坏例 id。
   * @param projectId - 归属项目。
   * @param resolvedBy - 销号人。
   * @returns 销号后的行；未命中时为 `null`。
   */
  async resolveBadcase(badcaseId: string, projectId: string, resolvedBy: string): Promise<BadcaseRow | null> {
    const { rows } = await this.db.query<BadcaseRow>(
      'UPDATE badcases b SET resolved = TRUE, resolved_by = $3::uuid, resolved_at = now()'
      + ' FROM audit_records a'
      + ' WHERE b.audit_id = a.id AND b.id = $1::uuid AND a.project_id = $2::uuid'
      + ' AND b.resolved = FALSE'
      + ' RETURNING b.id, b.audit_id, b.category, b.category_note, b.resolved, b.resolved_by, b.resolved_at, b.created_at',
      [badcaseId, projectId, resolvedBy],
    )
    return rows[0] ?? null
  }
}
