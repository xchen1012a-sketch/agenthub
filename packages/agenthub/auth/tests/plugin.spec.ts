import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

const pool = vi.hoisted(() => ({
  end: vi.fn(async () => undefined),
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}))

vi.mock('@agenthub/_shared', async importOriginal => ({
  ...await importOriginal<typeof import('@agenthub/_shared')>(),
  createAgenthubPool: () => pool,
}))

import { apply } from '../src/plugin.ts'

describe('@agenthub/auth plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('提供全进程共享数据库服务并在插件卸载时关闭连接池', async () => {
    const provided = new Map<string, unknown>()
    let dispose: (() => void) | undefined
    const context = {
      provide(name: string, value: unknown) {
        provided.set(name, value)
      },
      effect(register: () => () => void) {
        dispose = register()
      },
    } as unknown as Context

    apply(context)

    expect(provided.get('agenthub/db')).toBe(pool)
    expect(provided.get('agenthub/auth')).toBeDefined()
    expect(dispose).toBeDefined()
    dispose?.()
    await vi.waitFor(() => {
      expect(pool.end).toHaveBeenCalledOnce()
    })
  })
})
