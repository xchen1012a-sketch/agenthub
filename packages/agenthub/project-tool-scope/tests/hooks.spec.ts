/**
 * 事件转发（P2 方案书 T6 hooks.ts / D3 处置）：
 * 上游 tools/pre|post-execute → agenthub/tool.before|after-execute。
 *
 * @module tests/hooks.spec
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mount, runTool } from './mount.ts'
import { AGENTHUB_EVENTS, type ToolAfterExecutePayload, type ToolBeforeExecutePayload } from '@agenthub/_shared'
import { SessionToolScopeService, installToolEventBridge, registerManualTools } from '../src/index.ts'
import type { ToolCatalog } from '../src/index.ts'

class FakeCatalog implements ToolCatalog {
  constructor(private readonly risks: Record<string, string>) {}

  async allowedToolNames(): Promise<string[]> {
    return ['echo_read', 'noop_sensitive', 'boom.tool']
  }

  refresh(): Promise<void> {
    return Promise.resolve() // 目录在测试内静态；无缓存可失效。
  }

  async riskLevelOf(toolName: string): Promise<string | null> {
    return this.risks[toolName] ?? null
  }

  async businessToolNames(): Promise<string[]> {
    return this.allowedToolNames()
  }
}

/** 会失败的 Tool：驱动 after-execute status='error' 路径。 */
function boomTool(): ToolDefinition {
  return {
    name: 'boom.tool',
    description: 'always fails',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'unreachable' }],
    },
    execute: () => Promise.reject(new Error('boom')),
  }
}

const PROJECT = 'c0eeeeee-0000-4000-8000-00000000000c'
const RISKS = { 'echo_read': 'read', 'noop_sensitive': 'sensitive', 'boom.tool': 'write' }

async function wired() {
  const ctx = await mount()
  registerManualTools(ctx)
  ctx.tools.register(boomTool())
  const catalog = new FakeCatalog(RISKS)
  const scopes = new SessionToolScopeService(ctx, catalog)
  installToolEventBridge(ctx, { scopes, catalog, now: (() => {
    let tick = 100
    return () => (tick += 50)
  })() })
  return { ctx, scopes }
}

describe('installToolEventBridge（P2 T6 / D3）', () => {
  it('绑定 Session 执行 Tool → before/after 事件携带身份/项目/风险级别', async () => {
    const { ctx, scopes } = await wired()
    const before: ToolBeforeExecutePayload[] = []
    const after: ToolAfterExecutePayload[] = []
    ctx.on(AGENTHUB_EVENTS.toolBeforeExecute, payload => void before.push(payload))
    ctx.on(AGENTHUB_EVENTS.toolAfterExecute, payload => void after.push(payload))

    const key = { id: 'session-1' }
    await scopes.open(PROJECT, 'user-1', 'session-1', key)
    expect(await runTool(ctx, 'echo_read', { message: 'hi' }, key)).toBe('echo: hi')

    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({
      toolId: 'echo_read',
      args: { message: 'hi' },
      userId: 'user-1',
      projectId: PROJECT,
      sessionId: 'session-1',
      riskLevel: 'read',
    })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      toolId: 'echo_read',
      status: 'ok',
      userId: 'user-1',
      projectId: PROJECT,
      sessionId: 'session-1',
    })
    expect(after[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('敏感 Tool 风险级别来自 tools.risk_level（不由模型决定）', async () => {
    const { ctx, scopes } = await wired()
    const before: ToolBeforeExecutePayload[] = []
    ctx.on(AGENTHUB_EVENTS.toolBeforeExecute, payload => void before.push(payload))
    const key = { id: 'session-1' }
    await scopes.open(PROJECT, 'user-1', 'session-1', key)
    await runTool(ctx, 'noop_sensitive', { query: 'q', token: 'tk', password: 'pw', secret: 'sc' }, key)
    expect(before[0]!.riskLevel).toBe('sensitive')
  })

  it('执行失败 → after 事件 status=error', async () => {
    const { ctx, scopes } = await wired()
    const after: ToolAfterExecutePayload[] = []
    ctx.on(AGENTHUB_EVENTS.toolAfterExecute, payload => void after.push(payload))
    const key = { id: 'session-1' }
    await scopes.open(PROJECT, 'user-1', 'session-1', key)
    const text = await runTool(ctx, 'boom.tool', {}, key)
    expect(text).toContain('Error')
    expect(after).toHaveLength(1)
    expect(after[0]!.status).toBe('error')
  })

  it('未绑定 Session 的执行不发 agenthub 事件', async () => {
    const { ctx, scopes } = await wired()
    const before: ToolBeforeExecutePayload[] = []
    const after: ToolAfterExecutePayload[] = []
    ctx.on(AGENTHUB_EVENTS.toolBeforeExecute, payload => void before.push(payload))
    ctx.on(AGENTHUB_EVENTS.toolAfterExecute, payload => void after.push(payload))

    await runTool(ctx, 'echo_read', { message: 'hi' })
    await runTool(ctx, 'echo_read', { message: 'hi' }, { id: 'stranger' })
    expect(before).toEqual([])
    expect(after).toEqual([])
    // 绑定后正常发。
    const key = { id: 'session-2' }
    await scopes.open(PROJECT, 'user-1', 'session-2', key)
    await runTool(ctx, 'echo_read', { message: 'hi' }, key)
    expect(before).toHaveLength(1)
  })
})
