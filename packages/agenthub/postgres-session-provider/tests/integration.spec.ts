/**
 * 真实 PostgreSQL 集成测试（P2 方案书 T8 / V7）。
 * 方案书原文为 testcontainers；仓库无该依赖，改为经 AGENTHUB_TEST_DATABASE_URL
 * 连本机 PostgreSQL（未设置时整组跳过），要求迁移 0009 已应用。
 * JSONL 文件不产生由架构保证（本包无任何 fs 调用），服务级已断言全部持久
 * 语句均为 SQL；真实 profile 联调在 T10 收口时复核。
 *
 * @module tests/integration.spec
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError } from '@deepseek-ai/dsh-session-persistence'
import { PostgresSessionPersistence } from '../src/index.ts'

const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL
const POOL_SIZE = 30

function header(): SessionHeader {
  return {
    id: SessionId(`it-${randomUUID()}`),
    version: 4,
    createdAt: 1_700_000_000_000,
    isSeeded: false,
  }
}

function events(from: number, count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'turn/start',
    seq: SessionSeq(from + index),
    time: 0,
    data: { turn: from + index },
  }))
}

function wired(pool: Pool): PostgresSessionPersistence {
  // Service 基类构造只走 ctx.reflect.provide；插件装配时由 @agenthub/auth 提供 agenthub/db。
  const ctx = { reflect: { provide: () => {} } } as never
  return new PostgresSessionPersistence(ctx, pool)
}

describe.skipIf(integrationUrl === undefined)('agenthub_sessions 持久化（V7 集成）', () => {
  it('create → append 100 events → 跨 handle 回读全量 → 重复 create 拒绝', { timeout: 60_000 }, async () => {
    const pool = new Pool({ connectionString: integrationUrl })
    try {
      const service = wired(pool)
      const meta = header()
      const write = await service.create(meta)
      await write.append(events(0, 100))
      await write.close()

      const read = await service.open(meta.id, 'read')
      const slice = await read.read()
      expect(slice.events).toHaveLength(100)
      expect(slice.events[99]?.seq).toBe(SessionSeq(99))
      await read.close()

      const snapshot = await service.stat(meta.id)
      expect(snapshot?.eventCount).toBe(100)
      expect((await service.list()).some(item => item.header.id === meta.id)).toBe(true)
      await expect(service.create(meta)).rejects.toThrow(SessionAlreadyExistsError)
    } finally {
      await pool.end()
    }
  })

  it('V7：create + 100 events 写入 p95 ≤ 300ms（30 轮采样）', { timeout: 120_000 }, async () => {
    const pool = new Pool({ connectionString: integrationUrl })
    try {
      const service = wired(pool)
      const samples: number[] = []
      for (let round = 0; round < POOL_SIZE; round += 1) {
        const meta = header()
        const start = performance.now()
        const handle = await service.create(meta)
        await handle.append(events(0, 100))
        await handle.close()
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      const p95 = samples[Math.ceil(POOL_SIZE * 0.95) - 1]
      expect(p95).toBeLessThanOrEqual(300)
    } finally {
      await pool.end()
    }
  })

  it('seeded fork：继承前缀随首批 append 物理重写，cut 元数据 round-trip', async () => {
    const pool = new Pool({ connectionString: integrationUrl })
    try {
      const service = wired(pool)
      const meta = { ...header(), isSeeded: true, parentSession: SessionId('fork-parent') }
      const write = await service.create(meta, { inheritedEventCount: SessionLogOffset(3) })
      // fork 写入模式：继承前缀事件（seq 0-2）+ 新事件（seq 3 起）一批重写。
      await write.append([...events(0, 3), ...events(3, 2)])
      await write.close()
      const read = await service.open(meta.id, 'read')
      expect(read.inheritedEventCount).toBe(SessionLogOffset(3))
      expect((await read.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
      const snapshot = await service.stat(meta.id)
      expect(snapshot?.header.parentSession).toBe(SessionId('fork-parent'))
      expect(snapshot?.header.isSeeded).toBe(true)
      await read.close()
    } finally {
      await pool.end()
    }
  })
})
