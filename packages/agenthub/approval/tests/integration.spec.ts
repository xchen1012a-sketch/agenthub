/**
 * 带库端到端（P3 方案书阶段 B 验收）：真 PostgreSQL + 真 ToolRuntime +
 * 真 ApprovalService（上游 waterfall 全链，T0 Spike 的 fixture 实测）。
 *
 * 链路：noop_write（tools 表 risk_level=write）→ pre-execute 策略 ask →
 * 上游 serviceAsk → approval/request waterfall → approval 插件落库挂起 →
 * decide approve/reject → Tool 放行/阻断 + approvals.status 落库。
 *
 * 需要 AGENTHUB_TEST_DATABASE_URL（compose PG）；缺失时整组跳过。
 *
 * @module tests/integration.spec
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import pg from 'pg'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
// 走相对 src 导入（同 project-tool-scope/tests 先例）：包名入口解析到构建产物，
// 其内联实例的 kScope Symbol 与 vite 源码侧不一致，会导致 scopeOf 失效。
import { registerManualTools, SessionToolScopeService, ToolCatalogService } from '../../project-tool-scope/src/index.ts'
import { ApprovalGateService } from '../src/service.ts'
import { name as approvalName, apply as applyApproval, Config as ApprovalConfig } from '../src/plugin.ts'

const DB_URL = process.env.AGENTHUB_TEST_DATABASE_URL

describe.skipIf(DB_URL === undefined)('审批链路端到端（阶段 B 验收）', () => {
  let ctx: Context
  let pool: pg.Pool
  let scopes: SessionToolScopeService
  const projectId = randomUUID()
  const approverId = randomUUID()
  /** 越权修复验证：另一 Project 及其 admin（不属于本 Project）。 */
  const otherProjectId = randomUUID()
  const outsiderId = randomUUID()
  let callSeq = 0
  /**
   * agent 双重身份：同一对象既是 bindingOf 的 scope key（引用相等），又携带
   * ApprovalService 触达的 session 成员（fakeAgent 先例：seq/eventAt/append，
   * seed open turn 满足 request() 的 turn-enclosure 前置）。
   */
  let agentKey: object

  /** 以绑定 agent 身份执行 noop_write，返回首个 text block。 */
  async function runWrite(target: string): Promise<{ text: string; isError: boolean }> {
    callSeq += 1
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`it-${callSeq}`),
      name: 'noop_write',
      arguments: { target },
      agent: agentKey as never,
    })
    const first = result.content[0]
    return { text: first?.type === 'text' ? first.text : JSON.stringify(result.content), isError: result.isError }
  }

  function gate(): ApprovalGateService {
    const service = ctx.get('agenthub/approval') as ApprovalGateService | undefined
    if (service === undefined) throw new Error('agenthub/approval 未 provide')
    return service
  }

  async function statusOf(): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM approvals WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [projectId],
    )
    return rows[0]?.status ?? 'missing'
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL })
    // 残留清理：上一轮失败时 approvals 行会留下，使「最新一行」与三值齐全断言被污染。
    await pool.query('DELETE FROM approvals WHERE project_id = ANY($1::uuid[])', [[projectId, otherProjectId]])
    // 造数：approver 用户（平台 approver 角色）+ Project + project_tool_set（noop_write）。
    await pool.query(
      'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [approverId, `approver-${approverId}@integration.test`, '审批集成测试', 'test-only'],
    )
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'approver' ON CONFLICT DO NOTHING",
      [approverId],
    )
    await pool.query(
      'INSERT INTO projects (id, name, description, harness_workspace_id, created_by) VALUES ($1, $2, $3, $4, $5)',
      [projectId, 'approval-it', 'integration', `mem:${projectId}`, approverId],
    )
    await pool.query(
      'INSERT INTO project_tool_set (project_id, tool_id) SELECT $1, id FROM tools WHERE name = $2 ON CONFLICT DO NOTHING',
      [projectId, 'noop_write'],
    )
    // 越权修复造数：另一 Project + 其 admin 成员（不属于本 Project，无平台 approver 角色）。
    await pool.query(
      'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [outsiderId, `outsider-${outsiderId}@integration.test`, '他项目管理员', 'test-only'],
    )
    await pool.query(
      'INSERT INTO projects (id, name, description, harness_workspace_id, created_by) VALUES ($1, $2, $3, $4, $5)',
      [otherProjectId, 'approval-it-other', 'integration', `mem:${otherProjectId}`, outsiderId],
    )
    await pool.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
      [otherProjectId, outsiderId],
    )

    // 装配：真 ToolRuntime + 真 ApprovalService + approval 插件（经 provide 满足 inject）。
    ctx = new Context()
    const events: Array<{ type: string }> = [{ type: 'turn/start' }, { type: 'user/message' }]
    agentKey = {
      id: 'integration-agent',
      session: {
        get seq() { return events.length },
        eventAt: (seq: number) => events[seq],
        append: (type: string) => {
          events.push({ type })
          return { type } as never
        },
      },
    }
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService)
    registerManualTools(ctx)
    ctx.provide('agenthub/db', pool as never)
    scopes = new SessionToolScopeService(ctx, new ToolCatalogService(pool))
    ctx.provide('agenthub/tool-scope', scopes)
    await ctx.plugin({ name: approvalName, apply: applyApproval, Config: ApprovalConfig }, { failClosed: false })
    await scopes.open(projectId, approverId, 'integration-session', agentKey)
  })

  afterAll(async () => {
    await pool.query('DELETE FROM approvals WHERE project_id = $1', [projectId])
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId])
    await pool.query('DELETE FROM projects WHERE id = $1', [otherProjectId])
    await pool.query('DELETE FROM users WHERE id = $1', [approverId])
    await pool.query('DELETE FROM users WHERE id = $1', [outsiderId])
    await scopes.close(agentKey)
    await pool.end()
  })

  it('approve 分支：ask → 落库 pending → decide → Tool 放行 + status=approved', async () => {
    const pending = runWrite('approved-target')
    // pre-execute ask → waterfall 挂起（openApproval 落库后）；轮询等待 pending 行出现。
    for (let i = 0; i < 50 && await statusOf() !== 'pending'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(await statusOf()).toBe('pending')
    const record = await gate().decide((await lastApprovalId())!, approverId, 'approve', 'integration-approve')
    expect(record.status).toBe('approved')
    const result = await pending
    expect(result.isError).toBe(false)
    expect(result.text).toContain('approved-target')
    expect(await statusOf()).toBe('approved')
  })

  it('reject 分支：decide reject → Tool 阻断（deny）+ status=rejected', async () => {
    const pending = runWrite('rejected-target')
    for (let i = 0; i < 50 && await statusOf() !== 'pending'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(await statusOf()).toBe('pending')
    await gate().decide((await lastApprovalId())!, approverId, 'reject')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('rejected')
    expect(await statusOf()).toBe('rejected')
  })

  it('双 decide：同一审批第二次 → 409（首次决策生效）', async () => {
    const pending = runWrite('double-target')
    for (let i = 0; i < 50 && await statusOf() !== 'pending'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const approvalId = (await lastApprovalId())!
    await gate().decide(approvalId, approverId, 'approve')
    await expect(gate().decide(approvalId, approverId, 'reject')).rejects.toThrow(/首次决策/)
    await pending
  })

  it('expire 分支：超时未决 → expired（deny 方向），approvals.status 三值齐全', async () => {
    // 短 timeoutMs 服务直测超时结算（插件实例的 1h 计时不在测试窗口内驱动）。
    const shortGate = new ApprovalGateService(
      pool,
      { failClosed: false, timeoutHours: 1, minRiskLevel: 'write' },
      { onRequested: () => {}, onResolved: () => {} },
      { timeoutMs: 60 },
    )
    const outcome = shortGate.openApproval({
      toolId: (await pool.query<{ id: string }>("SELECT id FROM tools WHERE name = 'noop_write'")).rows[0]!.id,
      toolName: 'noop_write',
      riskLevel: 'write',
      args: { target: 'expire-direct' },
      projectId,
      userId: approverId,
      sessionId: 'integration-session',
    })
    expect(await outcome).toBe('rejected')
    // 不能按 args->>'target' 断言：`redactArgs` 只保留白名单字段（security.md §1.3 MUST），
    // `target` 不在白名单，落库的 args 本来就不含它。改为断言最新一行（本用例刚落的行）。
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM approvals WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [projectId],
    )
    expect(rows[0]?.status).toBe('expired')
    // 三值齐全（本组用例累计落库 approved / rejected / expired）。
    const { rows: all } = await pool.query<{ status: string }>(
      'SELECT DISTINCT status FROM approvals WHERE project_id = $1',
      [projectId],
    )
    expect(new Set(all.map(row => row.status))).toEqual(new Set(['approved', 'rejected', 'expired']))
  })

  it('跨 Project 越权：他 Project 的 admin 审批本 Project 单 → 403（越权修复）', async () => {
    const pending = runWrite('cross-project-target')
    for (let i = 0; i < 50 && await statusOf() !== 'pending'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const approvalId = (await lastApprovalId())!
    await expect(gate().decide(approvalId, outsiderId, 'approve')).rejects.toThrow(/不属于本 Project 的审批人/)
    // 收尾：本 Project 审批人拒绝，避免挂起的执行 Promise 泄漏。
    await gate().decide(approvalId, approverId, 'reject')
    expect(await statusOf()).toBe('rejected')
    await pending
  })

  it('listApprovals 范围：平台 approver 可见本 Project；他 Project 的 admin 不可见（越权修复）', async () => {
    const byPlatformApprover = await gate().listApprovals(approverId)
    expect(byPlatformApprover.some(row => row.projectId === projectId)).toBe(true)
    const byOutsiderAdmin = await gate().listApprovals(outsiderId)
    expect(byOutsiderAdmin.some(row => row.projectId === projectId)).toBe(false)
  })

  async function lastApprovalId(): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM approvals WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [projectId],
    )
    return rows[0]?.id ?? null
  }
})
