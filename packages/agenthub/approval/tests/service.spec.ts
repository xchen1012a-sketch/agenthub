/**
 * 审批门服务（P3 方案书阶段 B 预期 3/4：≥9 用例）。
 *
 * fake db 内存表按 SQL 形状分发，不引真 PG（带库链路见 integration.spec）。
 *
 * @module tests/service.spec
 */
import { describe, expect, it } from 'vitest'
import type { ApprovalRequestedPayload, ApprovalResolvedPayload, Queryable, ToolDeniedPayload } from '@agenthub/_shared'
import { ApprovalGateService, type ApprovalRecord, type StagedAsk } from '../src/service.ts'

/** 行形状：内存表内的 approvals 行（snake_case，同 SQL 层）。 */
interface FakeRow {
  id: string
  project_id: string
  user_id: string
  tool_id: string
  risk_level: string
  status: string
  approver_id: string | null
  decided_at: string | null
  reason: string | null
  created_at: string
  expires_at: string
}

/** 手动计时器队列（超时用例显式驱动）。 */
class FakeTimers {
  readonly fired: Array<() => void> = []
  readonly cancelled: number[] = []

  push(fn: () => void): void {
    this.fired.push(fn)
  }
}

/** INSERT approvals 的 8 元组参数形状。 */
type InsertParams = [string, string, string, string, string, string, string, string]

class FakeDb {
  readonly rows: FakeRow[] = []
  readonly insertParams: unknown[][] = []
  /** 平台 approver 用户集合（isApproverFor 的平台分支）。 */
  approverUserIds = new Set<string>()
  /** Project 维度审批人：projectId → userId 集合（isApproverFor 的项目分支）。 */
  readonly projectApprovers = new Map<string, Set<string>>()
  /** 全库审批人存在性（hasAnyApprover 用）。 */
  hasAnyApprover = true
  /** 该 Project 是否存在审批人（hasApproverForProject 用，阶段 C 运行时兜底）。 */
  projectHasApprover = true
  private readonly timers = new FakeTimers()

  get timerQueue(): FakeTimers {
    return this.timers
  }

  /** 假 DB 签名同 audit/tests/fakes 先例：非泛型 + 可选 values（按 SQL 形状回放）。 */
  async query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const params = values ?? []
    // INSERT INTO approvals ...（openApproval 落库 pending）
    if (sql.startsWith('INSERT INTO approvals')) {
      this.insertParams.push([...params])
      const [id, projectId, userId, toolId, riskLevel, , status, expiresAt] = params as InsertParams
      this.rows.push({
        id,
        project_id: projectId,
        user_id: userId,
        tool_id: toolId,
        risk_level: riskLevel,
        status,
        approver_id: null,
        decided_at: null,
        reason: null,
        created_at: new Date(0).toISOString(),
        expires_at: expiresAt,
      })
      return { rows: [] }
    }
    // 该 Project 是否存在审批人（hasApproverForProject：project_id = $1 AND role IN ...）
    if (sql.startsWith('SELECT EXISTS') && sql.includes('project_id = $1 AND role IN')) {
      return { rows: [{ ok: this.projectHasApprover }] }
    }
    // 全库审批人存在性
    if (sql.startsWith('SELECT EXISTS') && !sql.includes('AND ur.user_id')) {
      return { rows: [{ ok: this.hasAnyApprover }] }
    }
    // 指定用户是否为「该 Project」的审批人（$1=userId、$2=projectId：平台 ∪ 项目成员）
    if (sql.startsWith('SELECT EXISTS') && sql.includes('AND ur.user_id')) {
      const userId = String(params[0])
      const projectId = String(params[1])
      const ok = this.approverUserIds.has(userId)
        || (this.projectApprovers.get(projectId)?.has(userId) ?? false)
      return { rows: [{ ok }] }
    }
    // 孤儿清理（start）
    if (sql.startsWith("UPDATE approvals SET status = 'expired', decided_at = now() WHERE status = 'pending'")) {
      const expired: Array<{ id: string }> = []
      for (const row of this.rows) {
        if (row.status === 'pending') {
          row.status = 'expired'
          row.decided_at = new Date().toISOString()
          expired.push({ id: row.id })
        }
      }
      return { rows: expired }
    }
    // decide（首次决策生效：WHERE status='pending'）
    if (sql.startsWith('UPDATE approvals SET status = $3')) {
      const [id, approverId, status, reason] = params as [string, string, string, string | null]
      const row = this.rows.find(item => item.id === id && item.status === 'pending')
      if (row === undefined) return { rows: [] }
      row.status = status
      row.approver_id = approverId
      row.decided_at = new Date(1).toISOString()
      row.reason = reason
      return { rows: [{ ...row }] }
    }
    // signal abort 清理（删除 pending 行）
    if (sql.startsWith('DELETE FROM approvals')) {
      const id = String(params[0])
      const idx = this.rows.findIndex(item => item.id === id && item.status === 'pending')
      if (idx !== -1) this.rows.splice(idx, 1)
      return { rows: [] }
    }
    // expire（超时结算）
    if (sql.includes("WHERE id = $1 AND status = 'pending'")) {
      const id = String(params[0])
      const row = this.rows.find(item => item.id === id && item.status === 'pending')
      if (row === undefined) return { rows: [] }
      row.status = 'expired'
      row.decided_at = new Date(2).toISOString()
      return { rows: [{ ...row }] }
    }
    // decide 归属查询（JOIN tools 取 tool_name）
    if (sql.includes('FROM approvals a') && sql.includes('WHERE a.id = $1')) {
      const row = this.rows.find(item => item.id === String(params[0]))
      if (row === undefined) return { rows: [] }
      return { rows: [{ project_id: row.project_id, user_id: row.user_id, tool_name: 'fake.write' }] }
    }
    // 单行读取（conflictOf）
    if (sql.includes('FROM approvals WHERE id = $1')) {
      const row = this.rows.find(item => item.id === String(params[0]))
      return { rows: row === undefined ? [] : [{ ...row }] }
    }
    // 列表
    return { rows: this.rows.map(row => ({ ...row })) }
  }
}

const NOW = new Date('2026-10-02T08:00:00Z')

/**
 * 排空微/宏任务：openApproval 现为「审批人查询 → INSERT → 挂起」多段 await
 * （阶段 C 运行时兜底前置查询），单个 `await flush()` 不足以推进到落库。
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function staged(): StagedAsk {
  return {
    toolId: 'tool-uuid-1',
    toolName: 'fake.write',
    riskLevel: 'write',
    args: { note: 'hello', token: 'secret-value' },
    projectId: 'proj-1',
    userId: 'user-1',
    sessionId: 'sess-1',
  }
}

interface Harness {
  service: ApprovalGateService
  db: FakeDb
  requested: ApprovalRequestedPayload[]
  resolved: ApprovalResolvedPayload[]
  denied: ToolDeniedPayload[]
}

function harness(failClosed = true): Harness {
  const db = new FakeDb()
  db.approverUserIds.add('approver-1')
  const requested: ApprovalRequestedPayload[] = []
  const resolved: ApprovalResolvedPayload[] = []
  const denied: ToolDeniedPayload[] = []
  const service = new ApprovalGateService(
    db as unknown as Queryable,
    { failClosed, timeoutHours: 1, minRiskLevel: 'write' },
    {
      onRequested: (payload) => {
        requested.push(payload)
      },
      onResolved: (payload) => {
        resolved.push(payload)
      },
      onDenied: (payload) => {
        denied.push(payload)
      },
    },
    { now: () => NOW, setTimer: (ms, fn) => {
      db.timerQueue.push(fn)
      return () => {
        db.timerQueue.cancelled.push(ms)
      }
    } },
  )
  return { service, db, requested, resolved, denied }
}

describe('ApprovalGateService（阶段 B 预期 3/4）', () => {
  it('openApproval：落库 pending + 发 approval.requested（args 过脱敏）+ 挂起', async () => {
    const { service, db, requested } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ status: 'pending', risk_level: 'write', project_id: 'proj-1' })
    expect(db.rows[0]!.expires_at).toBe(new Date(NOW.getTime() + 3_600_000).toISOString())
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ toolId: 'tool-uuid-1', riskLevel: 'write', projectId: 'proj-1', requestedBy: 'user-1' })
    // 脱敏：token 值不进事件 payload。
    expect(JSON.stringify(requested[0]!.args)).not.toContain('secret-value')
    // 未决 → 挂起不结算。
    const settled = await Promise.race([outcome.then(() => 'settled'), Promise.resolve('pending')])
    expect(settled).toBe('pending')
  })

  it('decide approve：首次生效 → 挂起以 allowed-once 结算 + 发 approval.resolved(approved)', async () => {
    const { service, db, resolved } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    const approvalId = db.rows[0]!.id
    const record = await service.decide(approvalId, 'approver-1', 'approve', 'ok')
    expect(record.status).toBe('approved')
    expect(await outcome).toBe('allowed-once')
    expect(resolved[0]).toMatchObject({ status: 'approved', approverId: 'approver-1', reason: 'ok' })
  })

  it('decide reject：挂起以 rejected 结算（deny）', async () => {
    const { service, db, resolved } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    const approvalId = db.rows[0]!.id
    const record = await service.decide(approvalId, 'approver-1', 'reject')
    expect(record.status).toBe('rejected')
    expect(await outcome).toBe('rejected')
    expect(resolved[0]).toMatchObject({ status: 'rejected' })
  })

  it('双 decide：第二次 409（首次决策生效，后续拒绝）', async () => {
    const { service, db } = harness()
    // openApproval 返回的是审批门 Promise（decide/超时才结算），决策前不可 await。
    const outcome = service.openApproval(staged())
    await flush()
    const approvalId = db.rows[0]!.id
    await service.decide(approvalId, 'approver-1', 'approve')
    await expect(service.decide(approvalId, 'approver-1', 'reject')).rejects.toThrow(/首次决策/)
    expect(await outcome).toBe('allowed-once')
  })

  it('decide 不存在的审批 → 404', async () => {
    const { service } = harness()
    await expect(service.decide('00000000-0000-4000-8000-000000000000', 'approver-1', 'approve')).rejects.toThrow(/不存在/)
  })

  it('decide 非审批人 → 403（审批人 = 本 Project admin/approver ∪ 平台 approver）', async () => {
    const { service, db } = harness()
    void service.openApproval(staged())
    await flush()
    const approvalId = db.rows[0]!.id
    await expect(service.decide(approvalId, 'stranger', 'approve')).rejects.toThrow(/不属于本 Project 的审批人/)
  })

  it('decide 跨 Project：他 Project 的 admin 审批本 Project 单 → 403（越权修复）', async () => {
    const { service, db } = harness()
    void service.openApproval(staged())
    await flush()
    const approvalId = db.rows[0]!.id
    db.projectApprovers.set('proj-2', new Set(['admin-of-proj-2']))
    await expect(service.decide(approvalId, 'admin-of-proj-2', 'approve')).rejects.toThrow(/不属于本 Project 的审批人/)
    // 未结算：本 Project 单仍是 pending。
    expect(db.rows[0]!.status).toBe('pending')
  })

  it('decide 本 Project 的 admin → 放行（项目维度审批人资格）', async () => {
    const { service, db } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    const approvalId = db.rows[0]!.id
    db.projectApprovers.set('proj-1', new Set(['admin-of-proj-1']))
    const record = await service.decide(approvalId, 'admin-of-proj-1', 'approve')
    expect(record.status).toBe('approved')
    expect(await outcome).toBe('allowed-once')
  })

  it('超时：pending → expired → 挂起以 rejected 结算（deny）+ resolved(expired)', async () => {
    const { service, db, resolved } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    expect(db.timerQueue.fired).toHaveLength(1)
    db.timerQueue.fired[0]!()
    await flush()
    expect(db.rows[0]!.status).toBe('expired')
    expect(await outcome).toBe('rejected')
    expect(resolved[0]).toMatchObject({ status: 'expired', approverId: null })
  })

  it('孤儿 pending：启动时统一置 expired（fail-closed 方向）', async () => {
    const { service, db } = harness()
    db.rows.push({
      id: 'orphan-1',
      project_id: 'proj-1',
      user_id: 'user-1',
      tool_id: 'tool-uuid-1',
      risk_level: 'write',
      status: 'pending',
      approver_id: null,
      decided_at: null,
      reason: null,
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    })
    await service.start()
    expect(db.rows[0]!.status).toBe('expired')
  })

  it('failClosed=true 且全库无审批人 → 启动失败', async () => {
    const { service, db } = harness(true)
    db.hasAnyApprover = false
    await expect(service.start()).rejects.toThrow(/无审批人/)
  })

  it('failClosed=false 且全库无审批人 → warning 后继续（不抛错）', async () => {
    const { service, db } = harness(false)
    db.hasAnyApprover = false
    await expect(service.start()).resolves.toBeUndefined()
  })

  it('failClosed=true 且 minRiskLevel 非法 → 启动失败', async () => {
    const db = new FakeDb()
    const service = new ApprovalGateService(
      db as unknown as Queryable,
      { failClosed: true, timeoutHours: 1, minRiskLevel: 'bogus' as 'write' },
      { onRequested: () => {}, onResolved: () => {} },
      { now: () => NOW, setTimer: () => () => {} },
    )
    await expect(service.start()).rejects.toThrow(/配置非法/)
  })

  it('stageAsk / takeStaged：按 callId 消费一次；非本包 ask 返回 null', () => {
    const { service } = harness()
    service.stageAsk('call-1', staged())
    expect(service.takeStaged('call-1')).not.toBeNull()
    expect(service.takeStaged('call-1')).toBeNull()
    expect(service.takeStaged(undefined)).toBeNull()
    expect(service.takeStaged('unknown')).toBeNull()
  })

  it('listApprovals：返回行映射 camelCase（viewer + status 透传 SQL）', async () => {
    const { service } = harness()
    void service.openApproval(staged())
    await flush()
    const list: ApprovalRecord[] = await service.listApprovals('approver-1', 'pending')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ projectId: 'proj-1', toolId: 'tool-uuid-1', status: 'pending' })
    expect(list[0]!.decidedAt).toBeNull()
  })
})

describe('ApprovalGateService · 阶段 C denied 分支（T8 / D16）', () => {
  it('failClosed=true 且该 Project 无审批人 → 阻断（rejected）+ toolDenied(no_approver) + 不落库', async () => {
    const { service, db, denied } = harness(true)
    db.projectHasApprover = false
    const outcome = await service.openApproval(staged())
    expect(outcome).toBe('rejected')
    expect(db.rows).toHaveLength(0)
    expect(denied).toEqual([{
      toolId: 'fake.write',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      reason: 'denied:no_approver',
    }])
  })

  it('failClosed=false 且该 Project 无审批人 → 不阻断，正常落库 pending 并挂起', async () => {
    const { service, db, denied } = harness(false)
    db.projectHasApprover = false
    const outcome = service.openApproval(staged())
    await flush()
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]!.status).toBe('pending')
    expect(denied).toHaveLength(0)
    const settled = await Promise.race([outcome.then(() => 'settled'), Promise.resolve('pending')])
    expect(settled).toBe('pending')
  })

  it('decide reject → toolDenied(approval_rejected)，sessionId 回填供 audit 关联', async () => {
    const { service, db, denied } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    await service.decide(db.rows[0]!.id, 'approver-1', 'reject', '不同意')
    expect(await outcome).toBe('rejected')
    expect(denied).toEqual([{
      toolId: 'fake.write',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      reason: 'denied:approval_rejected',
    }])
  })

  it('decide approve → 不产生 toolDenied', async () => {
    const { service, db, denied } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    await service.decide(db.rows[0]!.id, 'approver-1', 'approve')
    expect(await outcome).toBe('allowed-once')
    expect(denied).toHaveLength(0)
  })

  it('超时 expired → toolDenied(approval_expired)', async () => {
    const { service, db, denied } = harness()
    const outcome = service.openApproval(staged())
    await flush()
    db.timerQueue.fired[0]!()
    await flush()
    expect(await outcome).toBe('rejected')
    expect(denied).toEqual([{
      toolId: 'fake.write',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      reason: 'denied:approval_expired',
    }])
  })
})

describe('ApprovalGateService · B-1/B-2/B-3 修复回归', () => {
  it('B-1：read + requires_approval 送审 → 落库 risk_level 归一为 write（合法 CHECK 值域）', async () => {
    const { service, db, requested } = harness()
    const outcome = service.openApproval({ ...staged(), riskLevel: 'read' })
    await flush()
    // 送审语义不变（read 仍走审批）；落库级别已归一，否则会抛原生 PG CHECK。
    expect(requested).toHaveLength(1)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ risk_level: 'write', status: 'pending' })
    const settled = await Promise.race([outcome.then(() => 'settled'), Promise.resolve('pending')])
    expect(settled).toBe('pending')
  })

  it('B-2：signal abort → 清 pending 内存 + 删 DB 行 + 不发 resolved/denied；decide → 404', async () => {
    const { service, db, resolved, denied } = harness()
    const controller = new AbortController()
    const outcome = service.openApproval(staged(), controller.signal)
    await flush()
    expect(db.rows).toHaveLength(1)
    const approvalId = db.rows[0]!.id
    controller.abort()
    await flush()
    // DB pending 行与 pending 内存条目均已清（decide 只能 404）；计时器已取消。
    expect(db.rows).toHaveLength(0)
    expect(db.timerQueue.cancelled).toContain(3_600_000)
    expect(resolved).toHaveLength(0)
    expect(denied).toHaveLength(0)
    expect(await outcome).toBe('rejected')
    await expect(service.decide(approvalId, 'approver-1', 'approve')).rejects.toThrow(/不存在/)
  })

  it('B-2：进入前 signal 已 abort → 不落库、不发任何事件', async () => {
    const { service, db, requested, resolved, denied } = harness()
    const controller = new AbortController()
    controller.abort()
    expect(await service.openApproval(staged(), controller.signal)).toBe('rejected')
    expect(db.rows).toHaveLength(0)
    expect(requested).toHaveLength(0)
    expect(resolved).toHaveLength(0)
    expect(denied).toHaveLength(0)
  })

  it('B-3：staged 超上限淘汰最旧（不无界泄漏）', () => {
    const db = new FakeDb()
    const service = new ApprovalGateService(
      db as unknown as Queryable,
      { failClosed: true, timeoutHours: 1, minRiskLevel: 'write' },
      { onRequested: () => {}, onResolved: () => {} },
      { now: () => NOW, stagedLimit: 2 },
    )
    service.stageAsk('oldest', staged())
    service.stageAsk('mid', staged())
    service.stageAsk('newest', staged())
    expect(service.takeStaged('oldest')).toBeNull()
    expect(service.takeStaged('mid')).not.toBeNull()
    expect(service.takeStaged('newest')).not.toBeNull()
  })
})
