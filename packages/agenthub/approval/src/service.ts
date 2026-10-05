/**
 * 审批门服务（P3 方案书 §4.1 审批链路 / 阶段 B T4）。
 *
 * 职责：
 * - 启动校验（failClosed=true：配置非法或全库无审批人 → 抛错，启动失败）；
 * - 孤儿 pending 清理（重启后统一置 expired，deny 方向）；
 * - `stageAsk` / `takeStaged`：pre-execute ask 上下文进程内暂存；
 * - `openApproval`：落库 pending + 发 approval.requested + 返回挂起 Promise；
 * - `decide`：首次决策生效（UPDATE 条件 pending），后续 409；
 * - 超时（expires_at 到点）→ expired → 挂起 Promise 以 rejected 结算（deny）。
 *
 * 身份/项目上下文一律来自 Session 绑定（security.md §2：模型入参不可决定）。
 * 审批人资格与审批列表均按 **Project 范围**收敛：跨 Project 既不可批、也不可见
 * （平台 approver 除外，其范围本就是全局）。
 *
 * @module @agenthub/approval/service
 */
import { randomUUID } from 'node:crypto'
import {
  AgenthubError,
  createLogger,
  redact,
  redactArgs,
  type Logger,
  type Queryable,
} from '@agenthub/_shared'
import type {
  ApprovalRequestedPayload,
  ApprovalResolvedPayload,
  ToolDeniedPayload,
} from '@agenthub/_shared'
import { isMinRiskLevel, toApprovalRiskLevel, type MinRiskLevel } from './policy.ts'

/** 管理台决策值（HTTP 层入参）。 */
export type ApprovalDecision = 'approve' | 'reject'

/** 审批插件配置（agenthub.yaml agenthub.approval 段，§4.4 默认）。 */
export interface ApprovalConfig {
  readonly failClosed: boolean
  readonly timeoutHours: number
  readonly minRiskLevel: MinRiskLevel
}

/** 事件回调（plugin.ts 注入，经 ctx.emit 发到事件总线）。 */
export interface ApprovalEventHooks {
  readonly onRequested: (payload: ApprovalRequestedPayload) => void
  readonly onResolved: (payload: ApprovalResolvedPayload) => void
  /**
   * 审批方向阻断事件（P3 阶段 C T8：denied 分支细化，偏离 D10 登记为 D16）。
   * audit 订阅后把对应 pending 行置 `status='denied'` 并把原因写 `result_meta.reason`。
   * reason 闭集：`denied:no_approver` / `denied:approval_rejected` / `denied:approval_expired`。
   */
  readonly onDenied?: (payload: ToolDeniedPayload) => void
}

/** 服务可选注入（测试用）。 */
export interface ApprovalServiceOptions {
  /** 覆盖 timeoutHours 的毫秒粒度计时（测试注入短值）。 */
  readonly timeoutMs?: number
  /** 时钟注入（测试）。 */
  readonly now?: () => Date
  /** 计时器注入（测试：手动驱动超时）。 */
  readonly setTimer?: (ms: number, fn: () => void) => () => void
  /** staged 暂存容量上限（默认 {@link DEFAULT_STAGED_LIMIT}；测试注入小值）。 */
  readonly stagedLimit?: number
}

/** pre-execute 判定 ask 后暂存的执行上下文。 */
export interface StagedAsk {
  readonly toolId: string
  readonly toolName: string
  readonly riskLevel: string
  /** 脱敏后的参数副本（落库 approvals.args）。 */
  readonly args: Record<string, unknown>
  readonly projectId: string
  readonly userId: string
  readonly sessionId: string
}

/** 审批列表行（管理台 / JSON API）。 */
export interface ApprovalRecord {
  readonly id: string
  readonly projectId: string
  readonly toolId: string
  readonly toolName: string
  readonly riskLevel: string
  readonly status: string
  readonly approverId: string | null
  readonly decidedAt: string | null
  readonly reason: string | null
  readonly createdAt: string
  readonly expiresAt: string
}

interface PendingEntry {
  readonly toolId: string
  readonly toolName: string
  readonly projectId: string
  /** 会话标识（decide 结算时回填 toolDenied 事件，供 audit 关联 pending 行）。 */
  readonly sessionId: string
  readonly userId: string
  resolve: (outcome: 'allowed-once' | 'rejected') => void
  cancelTimer: () => void
}

const DEFAULT_LIST_LIMIT = 100

/**
 * staged 暂存容量上限：`stageAsk` 后若未走到 `approval/request` waterfall
 * （无 open turn / signal 已 abort / policy=never / 无 agent），该 callId 条目
 * 无消费点可清除 → 无界泄漏。故设上限，超限淘汰最旧（Map 保持插入序）。
 */
const DEFAULT_STAGED_LIMIT = 1024

export class ApprovalGateService {
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly setTimer: (ms: number, fn: () => void) => () => void
  private readonly stagedLimit: number
  /** 挂起中的审批：approvalId → 结算句柄（进程内；单体架构无跨进程协调）。 */
  private readonly pending = new Map<string, PendingEntry>()
  /** pre-execute ask 暂存：callId → 执行上下文（approval/request 消费即删）。 */
  private readonly staged = new Map<string, StagedAsk>()

  constructor(
    private readonly db: Queryable,
    private readonly config: ApprovalConfig,
    private readonly hooks: ApprovalEventHooks,
    options?: ApprovalServiceOptions,
  ) {
    this.logger = createLogger('agenthub/approval')
    this.timeoutMs = options?.timeoutMs ?? config.timeoutHours * 3_600_000
    this.now = options?.now ?? ((): Date => new Date())
    this.stagedLimit = options?.stagedLimit ?? DEFAULT_STAGED_LIMIT
    this.setTimer = options?.setTimer ?? ((ms, fn) => {
      const handle = setTimeout(fn, ms)
      return () => {
        clearTimeout(handle)
      }
    })
  }

  /**
   * 启动校验 + 孤儿清理（plugin apply 内 await；抛错即装配失败 → 启动失败）。
   * failClosed=true：minRiskLevel 非法 / timeoutHours ≤ 0 / 全库无审批人 → 抛错；
   * failClosed=false：同条件降级 warning 继续。
   */
  async start(): Promise<void> {
    if (!isMinRiskLevel(this.config.minRiskLevel) || this.config.timeoutHours <= 0) {
      if (this.config.failClosed) {
        throw new AgenthubError('agenthub/approval/ConfigInvalid', '审批配置非法（minRiskLevel / timeoutHours）', { httpStatus: 500 })
      }
      this.logger.warn(
        { event: 'approval.config-invalid', projectId: null, userId: null, traceId: null, sessionId: null },
        { failClosed: false },
      )
    }
    const { rows: orphans } = await this.db.query<{ id: string }>(
      "UPDATE approvals SET status = 'expired', decided_at = now() WHERE status = 'pending' RETURNING id",
      [],
    )
    if (orphans.length > 0) {
      this.logger.warn(
        { event: 'approval.orphans-expired', projectId: null, userId: null, traceId: null, sessionId: null },
        { count: orphans.length },
      )
    }
    const hasApprover = await this.hasAnyApprover()
    if (!hasApprover) {
      if (this.config.failClosed) {
        throw new AgenthubError('agenthub/approval/NoApproverConfigured', 'failClosed=true 但全库无审批人（project_members admin/approver 与平台 approver 均为空）', { httpStatus: 500 })
      }
      this.logger.warn(
        { event: 'approval.no-approver', projectId: null, userId: null, traceId: null, sessionId: null },
        { failClosed: false },
      )
    }
    this.logger.info(
      { event: 'approval.started', projectId: null, userId: null, traceId: null, sessionId: null },
      { failClosed: this.config.failClosed, minRiskLevel: this.config.minRiskLevel, timeoutHours: this.config.timeoutHours },
    )
  }

  /** pre-execute 判定 ask 后暂存上下文（等 approval/request 按 callId 取走）。 */
  stageAsk(callId: string, staged: StagedAsk): void {
    this.staged.set(callId, staged)
    // 有界兜底：ask 后未走到 waterfall 的条目无消费点，超限淘汰最旧（Map 保序）。
    while (this.staged.size > this.stagedLimit) {
      const oldest = this.staged.keys().next().value
      if (oldest === undefined) break
      this.staged.delete(oldest)
    }
  }

  /** approval/request 消费暂存上下文；非本包发起的 ask 返回 null。 */
  takeStaged(callId: string | undefined): StagedAsk | null {
    if (callId === undefined) return null
    const staged = this.staged.get(callId)
    if (staged === undefined) return null
    this.staged.delete(callId)
    return staged
  }

  /**
   * approval/request listener 主体：落库 pending、发事件、挂起等待决策。
   * 返回的 Promise 由 decide / 超时结算（进程内 pending map）。
   *
   * `signal` 为上游 payload 的取消信号：abort 时上游已把本次 request 按 `cancelled`
   * 结算并 deny Tool，此处须清理 pending 内存条目与 DB pending 行，且**不再发任何
   * resolved/denied 事件**（避免 audit 把已取消单误置 denied / 残留 1h pending）。
   *
   * fail-closed 运行时兜底：failClosed=true 且该 Project 无任何审批人（平台 approver
   * 也为空）→ 不落库、直接以 `rejected` 结算并发出 `toolDenied(denied:no_approver)`
   * （启动期只校验全库，Project 维度需在请求时判定）。
   */
  async openApproval(staged: StagedAsk, signal?: AbortSignal): Promise<'allowed-once' | 'rejected'> {
    // 已 abort：上游在进入 waterfall 前已返回 cancelled，无需落库/发事件。
    if (signal?.aborted) return 'rejected'
    if (this.config.failClosed) {
      const hasApprover = await this.hasApproverForProject(staged.projectId)
      if (signal?.aborted) return 'rejected'
      if (!hasApprover) {
        this.hooks.onDenied?.({
          toolId: staged.toolName,
          projectId: staged.projectId,
          userId: staged.userId,
          sessionId: staged.sessionId,
          reason: 'denied:no_approver',
        })
        this.logger.warn(
          { event: 'approval.denied-no-approver', projectId: staged.projectId, userId: staged.userId, traceId: null, sessionId: staged.sessionId },
          { toolName: staged.toolName },
        )
        return 'rejected'
      }
    }
    const approvalId = randomUUID()
    const expiresAt = new Date(this.now().getTime() + this.timeoutMs)
    // B-1：approvals.risk_level CHECK 不含 read（database-schema.md §3.7），落库前归一。
    const riskLevel = toApprovalRiskLevel(staged.riskLevel)
    await this.db.query(
      'INSERT INTO approvals (id, project_id, user_id, tool_id, risk_level, args, status, expires_at)'
      + ' VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)',
      [
        approvalId,
        staged.projectId,
        staged.userId,
        staged.toolId,
        riskLevel,
        JSON.stringify(redactArgs(staged.args)),
        'pending',
        expiresAt.toISOString(),
      ],
    )
    // 落库途中 abort：清掉刚落库的 pending 行，不发任何事件。
    if (signal?.aborted) {
      await this.removePendingRow(approvalId)
      return 'rejected'
    }
    this.hooks.onRequested({
      approvalId,
      toolId: staged.toolId,
      riskLevel: staged.riskLevel,
      args: redact(staged.args) as Record<string, unknown>,
      projectId: staged.projectId,
      requestedBy: staged.userId,
    })
    return await new Promise<'allowed-once' | 'rejected'>((resolve) => {
      const cancelTimer = this.setTimer(this.timeoutMs, () => {
        void this.expire(approvalId, staged)
      })
      this.pending.set(approvalId, {
        toolId: staged.toolId,
        toolName: staged.toolName,
        projectId: staged.projectId,
        sessionId: staged.sessionId,
        userId: staged.userId,
        resolve,
        cancelTimer,
      })
      if (signal === undefined) return
      // 同步判定 + 同步挂载：abort 事件同步派发，二者之间无 await 不会漏挂。
      if (signal.aborted) {
        void this.cancelApproval(approvalId)
      } else {
        signal.addEventListener('abort', () => {
          void this.cancelApproval(approvalId)
        }, { once: true })
      }
    })
  }

  /**
   * signal abort 清理：移除 pending 内存条目（同步，防与 decide 双结算）、清计时器、
   * 删 DB pending 行，并以 `rejected` 结算挂起 Promise（结果被上游按 cancelled 丢弃）。
   * **不发任何 resolved/denied 事件**（abort 非人工决策、非超时）。
   */
  private async cancelApproval(approvalId: string): Promise<void> {
    const entry = this.pending.get(approvalId)
    if (entry === undefined) return
    this.pending.delete(approvalId)
    entry.cancelTimer()
    entry.resolve('rejected')
    await this.removePendingRow(approvalId)
  }

  /** 删除 pending 行（abort 清理；DB 异常降级日志，不冒泡为未处理拒绝）。 */
  private async removePendingRow(approvalId: string): Promise<void> {
    try {
      await this.db.query("DELETE FROM approvals WHERE id = $1 AND status = 'pending'", [approvalId])
    } catch (error: unknown) {
      this.logger.warn(
        { event: 'approval.cancel-cleanup-failed', projectId: null, userId: null, traceId: null, sessionId: null },
        { approvalId, error: error instanceof Error ? error.message : String(error) },
      )
    }
  }

  /**
   * 管理台决策（唯一决策点；首次生效，后续 409）。
   * 先取该审批所属 Project，再按 Project 维度校验审批人资格（跨 Project 一律 403）。
   * @throws AgenthubError 404（不存在）/ 403（非本 Project 审批人）/ 409（已决或已过期）。
   */
  async decide(
    approvalId: string,
    approverId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<ApprovalRecord> {
    const { rows: existing } = await this.db.query<{ project_id: string; user_id: string; tool_name: string | null }>(
      'SELECT a.project_id, a.user_id, COALESCE(t.name, \'\') AS tool_name'
      + ' FROM approvals a LEFT JOIN tools t ON t.id = a.tool_id WHERE a.id = $1',
      [approvalId],
    )
    const target = existing[0]
    if (target === undefined) {
      throw new AgenthubError('agenthub/approval/NotFound', '审批记录不存在', { httpStatus: 404 })
    }
    const allowed = await this.isApproverFor(approverId, target.project_id)
    if (!allowed) {
      throw new AgenthubError(
        'agenthub/approval/Forbidden',
        '该用户不属于本 Project 的审批人（project admin/approver 或平台 approver）',
        { httpStatus: 403 },
      )
    }
    const status = decision === 'approve' ? 'approved' : 'rejected'
    const { rows } = await this.db.query<ApprovalRow>(
      'UPDATE approvals SET status = $3, approver_id = $2, decided_at = now(), reason = $4'
      + ' WHERE id = $1 AND status = $5 RETURNING id, project_id, tool_id, risk_level, status, approver_id, decided_at, reason, created_at, expires_at',
      [approvalId, approverId, status, reason ?? null, 'pending'],
    )
    const row = rows[0]
    if (row === undefined) return await this.conflictOf(approvalId)
    const record = toRecord(row)
    // 结算前取挂起条目（sessionId 供 toolDenied 关联 audit pending 行）。
    const pendingEntry = this.pending.get(approvalId)
    this.settle(approvalId, decision === 'approve' ? 'allowed-once' : 'rejected')
    this.hooks.onResolved({
      approvalId,
      toolId: record.toolId,
      projectId: record.projectId,
      status,
      approverId,
      decidedAt: record.decidedAt ?? new Date().toISOString(),
      reason: reason ?? null,
    })
    if (decision === 'reject') {
      this.hooks.onDenied?.({
        toolId: target.tool_name ?? pendingEntry?.toolName ?? '',
        projectId: record.projectId,
        userId: target.user_id,
        sessionId: pendingEntry?.sessionId ?? null,
        reason: 'denied:approval_rejected',
      })
    }
    return record
  }

  /**
   * 审批列表（JSON API）。
   * 可见范围收敛到查看者的可审批 Project：平台 approver → 全部 Project；
   * 其余 → 仅自己为 admin/approver 的 Project（status 可选过滤）。
   */
  async listApprovals(viewerId: string, status?: string): Promise<ApprovalRecord[]> {
    const params: unknown[] = [viewerId]
    let where = ' WHERE ('
      + 'EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id'
      + ' WHERE r.name = \'approver\' AND ur.user_id = $1)'
      + ' OR a.project_id IN (SELECT pm.project_id FROM project_members pm'
      + ' WHERE pm.user_id = $1 AND pm.role IN (\'admin\', \'approver\')))'
    if (status !== undefined) {
      params.push(status)
      where += ' AND a.status = $2'
    }
    const { rows } = await this.db.query<ApprovalRow>(
      'SELECT a.id, a.project_id, a.tool_id, a.risk_level, a.status, a.approver_id, a.decided_at, a.reason, a.created_at, a.expires_at'
      + ', COALESCE(t.name, \'\') AS tool_name'
      + ' FROM approvals a LEFT JOIN tools t ON t.id = a.tool_id' + where
      + ' ORDER BY a.created_at DESC LIMIT ' + String(DEFAULT_LIST_LIMIT),
      params,
    )
    return rows.map(row => toRecord(row))
  }

  /** 超时结算：pending → expired → 挂起 Promise 以 rejected 结算（deny）。 */
  private async expire(approvalId: string, staged: StagedAsk): Promise<void> {
    const { rows } = await this.db.query<ApprovalRow>(
      "UPDATE approvals SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'"
      + ' RETURNING id, project_id, tool_id, risk_level, status, approver_id, decided_at, reason, created_at, expires_at',
      [approvalId],
    )
    const row = rows[0]
    if (row === undefined) return
    this.settle(approvalId, 'rejected')
    this.hooks.onResolved({
      approvalId,
      toolId: staged.toolId,
      projectId: staged.projectId,
      status: 'expired',
      approverId: null,
      decidedAt: iso(row.decided_at) ?? new Date().toISOString(),
      reason: null,
    })
    this.hooks.onDenied?.({
      toolId: staged.toolName,
      projectId: staged.projectId,
      userId: staged.userId,
      sessionId: staged.sessionId,
      reason: 'denied:approval_expired',
    })
    this.logger.warn(
      { event: 'approval.expired', projectId: staged.projectId, userId: null, traceId: null, sessionId: staged.sessionId },
      { approvalId },
    )
  }

  /** 结算挂起 Promise 并清计时器（幂等：已结算为 no-op）。 */
  private settle(approvalId: string, outcome: 'allowed-once' | 'rejected'): void {
    const entry = this.pending.get(approvalId)
    if (entry === undefined) return
    this.pending.delete(approvalId)
    entry.cancelTimer()
    entry.resolve(outcome)
  }

  /** UPDATE 0 行 → 区分 404 / 409（已决/已过期）。 */
  private async conflictOf(approvalId: string): Promise<ApprovalRecord> {
    const { rows } = await this.db.query<ApprovalRow>(
      'SELECT id, project_id, tool_id, risk_level, status, approver_id, decided_at, reason, created_at, expires_at FROM approvals WHERE id = $1',
      [approvalId],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new AgenthubError('agenthub/approval/NotFound', '审批记录不存在', { httpStatus: 404 })
    }
    throw new AgenthubError('agenthub/approval/AlreadyDecided', `审批已处于终态（status=${row.status}），首次决策生效后不可再次决策`, { httpStatus: 409 })
  }

  /** 全库是否存在任一审批人（平台 approver ∪ project_members admin/approver）。 */
  private async hasAnyApprover(): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = \'approver\')'
      + ' OR EXISTS (SELECT 1 FROM project_members WHERE role IN (\'admin\', \'approver\')) AS ok',
      [],
    )
    return rows[0]?.ok === true
  }

  /**
   * 该 Project 是否至少存在一名审批人（平台 approver ∪ 该项目 admin/approver 成员）。
   * 供 openApproval 在 failClosed=true 时做运行时兜底（启动期仅校验全库）。
   */
  async hasApproverForProject(projectId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = \'approver\')'
      + ' OR EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND role IN (\'admin\', \'approver\')) AS ok',
      [projectId],
    )
    return rows[0]?.ok === true
  }

  /** 指定用户是否为「该 Project」的审批人（平台 approver ∪ 该项目 admin/approver 成员）。 */
  private async isApproverFor(userId: string, projectId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = \'approver\' AND ur.user_id = $1)'
      + ' OR EXISTS (SELECT 1 FROM project_members WHERE project_id = $2 AND role IN (\'admin\', \'approver\') AND user_id = $1) AS ok',
      [userId, projectId],
    )
    return rows[0]?.ok === true
  }
}

/** approvals 表行（snake_case 原样；tool_name 仅列表 JOIN 时存在）。 */
interface ApprovalRow {
  readonly id: string
  readonly project_id: string
  readonly tool_id: string
  readonly tool_name?: string
  readonly risk_level: string
  readonly status: string
  readonly approver_id: string | null
  readonly decided_at: Date | string | null
  readonly reason: string | null
  readonly created_at: Date | string
  readonly expires_at: Date | string
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    toolId: row.tool_id,
    toolName: row.tool_name ?? '',
    riskLevel: row.risk_level,
    status: row.status,
    approverId: row.approver_id,
    decidedAt: iso(row.decided_at),
    reason: row.reason,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    expiresAt: iso(row.expires_at) ?? new Date().toISOString(),
  }
}
