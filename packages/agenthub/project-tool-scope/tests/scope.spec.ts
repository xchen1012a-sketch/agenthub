/**
 * V4：Project Tool 隔离（P2 方案书 §5 T6 / §7 V4）。
 *
 * ProjectA 的 Session tool list ⊆ ProjectA tool set，断言不含 ProjectB 任何 tool 名。
 *
 * @module tests/scope.spec
 */
import { describe, expect, it } from 'vitest'
import { mount, runTool } from './mount.ts'
import { SessionToolScopeService, ToolCatalogService, registerManualTools } from '../src/index.ts'
import type { ToolCatalog } from '../src/index.ts'

/** 假目录：固定 Project → allow 名单映射（隔离语义单测不触 DB）。 */
class FakeCatalog implements ToolCatalog {
  constructor(
    private readonly data: Record<string, string[]>,
    private readonly refreshed: string[] = [],
  ) {}

  async allowedToolNames(projectId: string): Promise<string[]> {
    return this.data[projectId] ?? []
  }

  refresh(projectId: string): Promise<void> {
    this.refreshed.push(projectId)
    return Promise.resolve()
  }

  async riskLevelOf(): Promise<string | null> {
    return null
  }

  async businessToolNames(): Promise<string[]> {
    return [...new Set(Object.values(this.data).flat())]
  }
}

const A = 'a0eeeeee-0000-4000-8000-00000000000a'
const B = 'b0eeeeee-0000-4000-8000-00000000000b'

describe('SessionToolScopeService.open（V4 Project Tool 隔离）', () => {
  it('ProjectA Session 只见 A 的 Tool，不含 ProjectB 任何 tool 名', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({
      [A]: ['echo_read', 'noop_write'],
      [B]: ['noop_sensitive'],
    }))
    const keyA = { id: 'session-a' }
    await scopes.open(A, 'user-1', 'session-a', keyA)

    const namesA = ctx.tools.schemas(keyA as never).map(schema => schema.name)
    expect(namesA.sort()).toEqual(['echo_read', 'noop_write'])
    // V4 核心：不含 ProjectB 的任何 tool 名。
    for (const name of ['noop_sensitive']) {
      expect(namesA).not.toContain(name)
    }
    // 越权执行与不存在工具不可区分。
    expect(await runTool(ctx, 'noop_sensitive', { query: 'q' }, keyA)).toContain('unknown tool')
    expect(await runTool(ctx, 'echo_read', { message: 'hi' }, keyA)).toBe('echo: hi')
  })

  it('双向隔离：B 看不到 A 的 Tool', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({
      [A]: ['echo_read'],
      [B]: ['noop_sensitive'],
    }))
    const keyA = { id: 'session-a' }
    const keyB = { id: 'session-b' }
    await scopes.open(A, 'user-1', 'session-a', keyA)
    await scopes.open(B, 'user-2', 'session-b', keyB)

    expect(ctx.tools.schemas(keyB as never).map(schema => schema.name)).toEqual(['noop_sensitive'])
    expect(ctx.tools.schemas(keyA as never).map(schema => schema.name)).toEqual(['echo_read'])
  })

  it('fail-closed：无 Tool Set 配置 → allow 空列表 → 全禁', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({}))
    const key = { id: 'session-x' }
    await scopes.open(A, 'user-1', 'session-x', key)
    expect(ctx.tools.schemas(key as never)).toEqual([])
    expect(await runTool(ctx, 'echo_read', { message: 'hi' }, key)).toContain('unknown tool')
  })

  it('DB 名单含未注册 Tool 名时过滤掉，不炸 restrict', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({
      [A]: ['echo_read', 'future.openapi.tool'],
    }))
    const key = { id: 'session-a' }
    await scopes.open(A, 'user-1', 'session-a', key)
    expect(ctx.tools.schemas(key as never).map(schema => schema.name)).toEqual(['echo_read'])
  })

  it('refresh 重算 allow 列表（Tool Set 变更后生效）', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const catalog = new FakeCatalog({ [A]: ['echo_read'] })
    const scopes = new SessionToolScopeService(ctx, catalog)
    const key = { id: 'session-a' }
    const handle = await scopes.open(A, 'user-1', 'session-a', key)
    expect(ctx.tools.schemas(key as never).map(schema => schema.name)).toEqual(['echo_read'])

    ;(catalog as unknown as { data: Record<string, string[]> }).data[A] = ['noop_write']
    await handle.refresh(catalog, ctx)
    expect(ctx.tools.schemas(key as never).map(schema => schema.name)).toEqual(['noop_write'])
  })

  it('重复 open 同一 Session key 拒绝；close 后解除隔离并移除绑定', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({ [A]: ['echo_read'] }))
    const key = { id: 'session-a' }
    await scopes.open(A, 'user-1', 'session-a', key)
    await expect(scopes.open(A, 'user-1', 'session-a', key)).rejects.toThrow(/already open/)

    await scopes.close(key)
    expect(scopes.bindingOf(key)).toBeNull()
    // 全局视图不受影响（其他消费者仍可见全部 Tool）。
    expect(ctx.tools.schemas().map(schema => schema.name)).toHaveLength(3)
  })

  it('未绑定会话隐藏业务 Tool，其余 Tool 仍可见；没有身份登记', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({ [A]: ['echo_read', 'noop_write'] }))
    const key = { id: 'session-folder' }
    await scopes.hide(key, 'session-folder')
    expect(ctx.tools.schemas(key as never).map(schema => schema.name)).toEqual(['noop_sensitive'])
    expect(await runTool(ctx, 'echo_read', { message: 'hi' }, key)).toContain('unknown tool')
    expect(scopes.bindingOf(key)).toBeNull()
    await expect(scopes.open(A, 'user-1', 'session-folder', key)).rejects.toThrow(/unbound/)

    await scopes.close(key)
    expect(ctx.tools.schemas(key as never).map(schema => schema.name)).toHaveLength(3)
  })

  it('打开登记经服务认领（chat intent）', async () => {
    const ctx = await mount()
    const scopes = new SessionToolScopeService(ctx, new FakeCatalog({}), () => 0)
    scopes.expectChat(A, 'user-1')
    expect(scopes.claimChat(B)).toEqual({ kind: 'none' })
    expect(scopes.claimChat(A)).toEqual({ kind: 'owner', userId: 'user-1' })
  })

  it('ToolCatalogService.businessToolNames：tools 表全部名 ∪ 手动示例 Tool', async () => {
    const fakeDb = {
      async query(text: string): Promise<{ rows: { name: string }[] }> {
        expect(text).toBe('SELECT name FROM tools')
        return { rows: [{ name: 'echo_read' }, { name: 'erp.listOrders' }] }
      },
    }
    const names = await new ToolCatalogService(fakeDb as never).businessToolNames()
    expect(names.sort()).toEqual(['echo_read', 'erp.listOrders', 'noop_sensitive', 'noop_write'])
  })

  it('ToolCatalogService 走真实 SQL 形状（假 pg 行回放）', async () => {
    const queries: { text: string; values?: readonly unknown[] }[] = []
    const fakeDb = {
      async query(text: string, values?: readonly unknown[]): Promise<{ rows: { name: string; risk_level?: string }[] }> {
        queries.push({ text, ...(values !== undefined ? { values } : {}) })
        if (text.includes('project_tool_set')) {
          return { rows: [{ name: 'echo_read' }] }
        }
        return { rows: [{ name: 'echo_read', risk_level: 'read' }] }
      },
    }
    const catalog = new ToolCatalogService(fakeDb as never)
    expect(await catalog.allowedToolNames(A)).toEqual(['echo_read'])
    expect(await catalog.riskLevelOf('echo_read')).toBe('read')
    expect(await catalog.riskLevelOf('missing.tool')).toBeNull()
    await catalog.refresh(A)
    // 第二次查询命中缓存（不再发 SQL）——refresh 后失效重查。
    expect(queries.filter(item => item.text.includes('project_tool_set'))).toHaveLength(1)
  })
})
