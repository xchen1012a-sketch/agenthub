/**
 * 审计落库服务（P2 方案书 T7 / V5 audit_args_redacted；P3 阶段 C T8 denied + approval 关联）。
 *
 * @module tests/service.spec
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { asTraceId, type Queryable } from '@agenthub/_shared'
import { AuditService, type TraceIdResolver } from '../src/index.ts'
import { FakeDb } from './fakes.ts'
import type {
  ApprovalResolvedPayload,
  ToolAfterExecutePayload,
  ToolBeforeExecutePayload,
  ToolDeniedPayload,
} from '@agenthub/_shared'

const PROJECT = 'd0eeeeee-0000-4000-8000-00000000000d'
const USER = 'e0eeeeee-0000-4000-8000-00000000000e'

function beforePayload(overrides: Partial<ToolBeforeExecutePayload> = {}): ToolBeforeExecutePayload {
  return {
    toolId: 'noop_sensitive',
    args: { query: 'q', token: 'tk-secret-1', password: 'pw-secret-1', secret: 'sc-secret-1' },
    userId: USER,
    projectId: PROJECT,
    sessionId: 'session-1',
    riskLevel: 'sensitive',
    ...overrides,
  }
}

function afterPayload(overrides: Partial<ToolAfterExecutePayload> = {}): ToolAfterExecutePayload {
  return {
    toolId: 'noop_sensitive',
    durationMs: 42,
    status: 'ok',
    userId: USER,
    projectId: PROJECT,
    sessionId: 'session-1',
    ...overrides,
  }
}

function deniedPayload(overrides: Partial<ToolDeniedPayload> = {}): ToolDeniedPayload {
  return {
    toolId: 'noop_sensitive',
    projectId: PROJECT,
    userId: USER,
    sessionId: 'session-1',
    reason: 'denied:upstream_403',
    ...overrides,
  }
}

function resolvedPayload(overrides: Partial<ApprovalResolvedPayload> = {}): ApprovalResolvedPayload {
  return {
    approvalId: 'approval-0001',
    toolId: 'tool-0001',
    projectId: PROJECT,
    status: 'approved',
    approverId: USER,
    decidedAt: '2026-10-02T00:00:00.000Z',
    reason: null,
    ...overrides,
  }
}

function wired(resolveTraceId: TraceIdResolver = () => null) {
  const db = new FakeDb({ id: 'tool-0001', risk_level: 'sensitive' })
  const service = new AuditService(db as unknown as Queryable, resolveTraceId)
  return { db, service }
}

describe('AuditService.recordBeforeExecute（V5 audit_args_redacted）', () => {
  it('args 落库前脱敏：token/password/secret → ***，无明文', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    const insert = db.statements.find(item => item.text.includes('INSERT INTO audit_records'))
    expect(insert).toBeDefined()
    const argsJson = JSON.stringify(insert?.values?.[5])
    expect(argsJson).toContain('***')
    expect(argsJson).not.toContain('tk-secret-1')
    expect(argsJson).not.toContain('pw-secret-1')
    expect(argsJson).not.toContain('sc-secret-1')
    // 白名单字段保留。
    expect(argsJson).toContain('q')
  })

  it('redactArgs 默认拒绝：非白名单键（nested）整体丢弃，敏感键置 ***', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload({
      args: { query: 'q', nested: { apiToken: 'inner-secret' }, token: 'tk-secret-1' },
    }))
    const insert = db.statements.find(item => item.text.includes('INSERT'))
    const argsJson = JSON.stringify(insert?.values?.[5])
    expect(argsJson).not.toContain('inner-secret')
    expect(argsJson).not.toContain('tk-secret-1')
    // 非白名单键被丢弃（不落库、不臆造 ***）。
    expect(argsJson).not.toContain('nested')
    expect(argsJson).toContain('***')
  })

  it('已登记 Tool：tool_id / risk_level 取自 tools 表', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    const select = db.statements.find(item => item.text.startsWith('SELECT id, risk_level'))
    expect(select?.values).toEqual(['noop_sensitive'])
    const insert = db.statements.find(item => item.text.includes('INSERT INTO audit_records'))
    expect(insert?.values?.[3]).toBe('tool-0001')
    expect(insert?.values?.[6]).toBe('sensitive')
    expect(insert?.values?.[7]).toBe('pending')
  })

  it('未登记 Tool：tool_id 为空，risk_level 按 critical（fail-closed）', async () => {
    const db = new FakeDb(null)
    const service = new AuditService(db as unknown as Queryable, () => null)
    await service.recordBeforeExecute(beforePayload({ toolId: 'ghost.tool' }))
    const insert = db.statements.find(item => item.text.includes('INSERT INTO audit_records'))
    expect(insert?.values?.[3]).toBeNull()
    expect(insert?.values?.[6]).toBe('critical')
  })

  it('trace_id：解析器为 null 时 UUIDv4 兜底', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    const traceId = db.statements.find(item => item.text.includes('INSERT'))?.values?.[8] as string
    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('trace_id：请求 ctx 提供时透传（OBS-3 同源）', async () => {
    const fixed = asTraceId(randomUUID())
    const { db, service } = wired(() => fixed)
    await service.recordBeforeExecute(beforePayload())
    expect(db.statements.find(item => item.text.includes('INSERT'))?.values?.[8]).toBe(fixed)
  })
})

describe('AuditService.recordAfterExecute', () => {
  it('回写 status 与 result_meta.durationMs，并清空 pending', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    expect(service.pendingCount()).toBe(1)
    await service.recordAfterExecute(afterPayload())
    const update = db.statements.find(item => item.text.startsWith('UPDATE audit_records'))
    expect(update).toBeDefined()
    expect(update?.values?.[1]).toBe('ok')
    expect(update?.values?.[2]).toBe(JSON.stringify({ durationMs: 42 }))
    expect(service.pendingCount()).toBe(0)
  })

  it('error 状态同样回写；无 pending 行时跳过（orphan）', async () => {
    const { db, service } = wired()
    await service.recordAfterExecute(afterPayload({ status: 'error' }))
    expect(db.statements.find(item => item.text.startsWith('UPDATE'))).toBeUndefined()
    await service.recordBeforeExecute(beforePayload())
    await service.recordAfterExecute(afterPayload({ status: 'error', durationMs: 7 }))
    const update = db.statements.find(item => item.text.startsWith('UPDATE audit_records'))
    expect(update?.values?.[1]).toBe('error')
    expect(update?.values?.[2]).toBe(JSON.stringify({ durationMs: 7 }))
  })

  it('不同 (项目, 用户, 会话, 工具) 组合互不串行', async () => {
    const { service } = wired()
    await service.recordBeforeExecute(beforePayload())
    await service.recordBeforeExecute(beforePayload({ sessionId: 'session-2' }))
    expect(service.pendingCount()).toBe(2)
    await service.recordAfterExecute(afterPayload({ sessionId: 'session-2' }))
    expect(service.pendingCount()).toBe(1)
  })
})

describe('AuditService.recordDenied（P3 阶段 C T8 / D16）', () => {
  it('pending 行 → status=denied，细分原因落 result_meta.reason，并清 pending', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    expect(service.pendingCount()).toBe(1)
    await service.recordDenied(deniedPayload())
    const update = db.statements.find(item => item.text.startsWith('UPDATE audit_records SET status'))
    expect(update?.values?.[0]).toBe('audit-0001')
    expect(update?.values?.[1]).toBe('denied')
    expect(update?.values?.[2]).toBe(JSON.stringify({ reason: 'denied:upstream_403' }))
    // 细分原因不得写进 status 列（CHECK 只收四枚举）。
    expect(update?.values?.[1]).not.toContain('denied:')
    expect(service.pendingCount()).toBe(0)
  })

  it('reason 取闭集值：credential_expired / no_approver 原样落 result_meta', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    await service.recordDenied(deniedPayload({ reason: 'denied:credential_expired' }))
    expect(db.statements.find(item => item.text.startsWith('UPDATE audit_records SET status'))?.values?.[2])
      .toBe(JSON.stringify({ reason: 'denied:credential_expired' }))

    await service.recordBeforeExecute(beforePayload())
    await service.recordDenied(deniedPayload({ reason: 'denied:no_approver' }))
    expect(db.statements.filter(item => item.text.startsWith('UPDATE audit_records SET status')).at(-1)?.values?.[2])
      .toBe(JSON.stringify({ reason: 'denied:no_approver' }))
  })

  it('无 pending 行 → 跳过（orphan，不写库、不阻断）', async () => {
    const { db, service } = wired()
    await service.recordDenied(deniedPayload())
    expect(db.statements.some(item => item.text.startsWith('UPDATE audit_records SET status'))).toBe(false)
  })

  it('关联键不匹配（不同会话）→ 不误伤其他 pending 行', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload({ sessionId: 'session-2' }))
    await service.recordDenied(deniedPayload({ sessionId: 'session-1' }))
    expect(db.statements.some(item => item.text.startsWith('UPDATE audit_records SET status'))).toBe(false)
    expect(service.pendingCount()).toBe(1)
  })

  it('C-6 竞态：before 尚未落库时 denied 先到 → 仍回写同一 pending 行（不再永停 pending）', async () => {
    const db = new FakeDb({ id: 'tool-0001', risk_level: 'sensitive' })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    db.beforeInsert = () => gate
    const service = new AuditService(db as unknown as Queryable, () => null)
    // 模拟 listener 未 await before（同步发出 before 事件后立刻发出 denied）。
    const before = service.recordBeforeExecute(beforePayload())
    const denied = service.recordDenied(deniedPayload())
    release()
    await denied
    await before
    const update = db.statements.find(item => item.text.startsWith('UPDATE audit_records SET status'))
    expect(update?.values?.[1]).toBe('denied')
    expect(service.pendingCount()).toBe(0)
  })
})

describe('AuditService.recordApprovalResolved（P3 阶段 C T8）', () => {
  it('按 Project + Tool 回填 approval_id 到最近一行（不限 status，三种时序均可命中）', async () => {
    const { db, service } = wired()
    await service.recordApprovalResolved(resolvedPayload())
    const update = db.statements.find(item => item.text.startsWith('UPDATE audit_records SET approval_id'))
    expect(update).toBeDefined()
    expect(update?.values).toEqual(['approval-0001', PROJECT, 'tool-0001'])
    expect(update?.text).toContain('project_id = $2')
    expect(update?.text).toContain('tool_id = $3')
    expect(update?.text).toContain('ORDER BY created_at DESC LIMIT 1')
    expect(update?.text).not.toContain("status = 'pending'")
  })

  it('rejected / expired 结算同样回填（先 resolved 后 denied，不影响 approval_id）', async () => {
    const { db, service } = wired()
    await service.recordBeforeExecute(beforePayload())
    await service.recordApprovalResolved(resolvedPayload({ status: 'rejected', approverId: USER, reason: '不给过' }))
    await service.recordDenied(deniedPayload({ reason: 'denied:approval_rejected' }))
    expect(db.statements.some(item => item.text.startsWith('UPDATE audit_records SET approval_id'))).toBe(true)
    expect(db.statements.find(item => item.text.startsWith('UPDATE audit_records SET status'))?.values?.[2])
      .toBe(JSON.stringify({ reason: 'denied:approval_rejected' }))
  })
})
