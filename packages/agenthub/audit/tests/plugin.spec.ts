/**
 * @agenthub/audit 插件装配（P2 方案书 T7）。
 *
 * @module tests/plugin.spec
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AGENTHUB_EVENTS } from '@agenthub/_shared'
import { apply, inject } from '../src/index.ts'
import { FakeDb } from './fakes.ts'

describe('@agenthub/audit plugin', () => {
  it('通过静态 inject 元数据声明共享数据库依赖', () => {
    expect(inject).toEqual(['agenthub/db'])
  })

  it('订阅 agenthub/tool.* 事件并写 audit_records（旁路，不阻断执行）', async () => {
    const ctx = new Context()
    const db = new FakeDb()
    ctx.provide('agenthub/db', db)
    apply(ctx)
    await new Promise(resolve => setImmediate(resolve))

    ctx.emit(AGENTHUB_EVENTS.toolBeforeExecute, {
      toolId: 'echo_read',
      args: { message: 'hi' },
      userId: 'f0eeeeee-0000-4000-8000-00000000000f',
      projectId: 'a1eeeeee-0000-4000-8000-00000000000a',
      sessionId: 'session-9',
      riskLevel: 'read',
    })
    await new Promise(resolve => setImmediate(resolve))

    ctx.emit(AGENTHUB_EVENTS.toolAfterExecute, {
      toolId: 'echo_read',
      durationMs: 5,
      status: 'ok',
      userId: 'f0eeeeee-0000-4000-8000-00000000000f',
      projectId: 'a1eeeeee-0000-4000-8000-00000000000a',
      sessionId: 'session-9',
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(db.statements.some(item => item.text.includes('INSERT INTO audit_records'))).toBe(true)
    expect(db.statements.some(item => item.text.startsWith('UPDATE audit_records'))).toBe(true)
  })

  it('订阅 tool.denied → status=denied + result_meta.reason；订阅 approval.resolved → 回填 approval_id', async () => {
    const ctx = new Context()
    const db = new FakeDb()
    ctx.provide('agenthub/db', db)
    apply(ctx)
    await new Promise(resolve => setImmediate(resolve))

    // 先建 pending 行（denied 需关联该行）。
    ctx.emit(AGENTHUB_EVENTS.toolBeforeExecute, {
      toolId: 'echo_read',
      args: { message: 'hi' },
      userId: 'f0eeeeee-0000-4000-8000-00000000000f',
      projectId: 'a1eeeeee-0000-4000-8000-00000000000a',
      sessionId: 'session-denied',
      riskLevel: 'read',
    })
    await new Promise(resolve => setImmediate(resolve))

    ctx.emit(AGENTHUB_EVENTS.toolDenied, {
      toolId: 'echo_read',
      projectId: 'a1eeeeee-0000-4000-8000-00000000000a',
      userId: 'f0eeeeee-0000-4000-8000-00000000000f',
      sessionId: 'session-denied',
      reason: 'denied:upstream_403',
    })
    await new Promise(resolve => setImmediate(resolve))

    ctx.emit(AGENTHUB_EVENTS.approvalResolved, {
      approvalId: 'approval-0001',
      toolId: 'tool-0001',
      projectId: 'a1eeeeee-0000-4000-8000-00000000000a',
      status: 'rejected',
      approverId: null,
      decidedAt: '2026-10-02T00:00:00.000Z',
      reason: null,
    })
    await new Promise(resolve => setImmediate(resolve))

    const denied = db.statements.find(item => item.text.startsWith('UPDATE audit_records SET status'))
    expect(denied?.values?.[1]).toBe('denied')
    expect(denied?.values?.[2]).toBe(JSON.stringify({ reason: 'denied:upstream_403' }))
    expect(db.statements.some(item => item.text.startsWith('UPDATE audit_records SET approval_id'))).toBe(true)
  })
})
