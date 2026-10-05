/**
 * 手动示例 Tool 行为（P2 方案书 §4.3）。
 *
 * @module tests/tools.spec
 */
import { describe, expect, it } from 'vitest'
import { runTool, mount } from './mount.ts'
import { MANUAL_TOOL_NAMES, echoReadTool, noopSensitiveTool, noopWriteTool, registerManualTools } from '../src/index.ts'

describe('3 个手动示例 Tool（P2 方案书 §4.3）', () => {
  it('经真实 Registry 注册并列出，名字与 0007 种子一致', async () => {
    const ctx = await mount()
    const dispose = registerManualTools(ctx)
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([...MANUAL_TOOL_NAMES].sort())
    dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('echo_read 原样返回输入参数', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    expect(await runTool(ctx, 'echo_read', { message: '你好' })).toBe('echo: 你好')
  })

  it('noop_write 无副作用并返回 ok', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    expect(await runTool(ctx, 'noop_write', { target: 'doc-1' })).toBe('noop_write: 已模拟写入 doc-1')
  })

  it('noop_sensitive 接受敏感字段参数（V5 脱敏夹具）', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const text = await runTool(ctx, 'noop_sensitive', {
      query: 'q',
      token: 'tk-1',
      password: 'pw-1',
      secret: 'sc-1',
    })
    expect(text).toBe('noop_sensitive: q')
  })

  it('schema 校验：缺必填参数被拒绝', async () => {
    const ctx = await mount()
    registerManualTools(ctx)
    const text = await runTool(ctx, 'echo_read', {})
    expect(text).toContain('Error')
  })

  it('三个工厂各自返回独立定义对象', () => {
    expect(echoReadTool().name).toBe('echo_read')
    expect(noopWriteTool().name).toBe('noop_write')
    expect(noopSensitiveTool().name).toBe('noop_sensitive')
  })
})
