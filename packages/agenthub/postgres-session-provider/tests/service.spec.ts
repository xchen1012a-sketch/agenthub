/**
 * PostgresSessionPersistence 服务级测试（P2 方案书 T8，P1 起 FakeDb 模式）。
 * V7 的 p95 时延与真实持久断言在 integration.spec.ts（AGENTHUB_TEST_DATABASE_URL）。
 *
 * @module tests/service.spec
 */
import { describe, expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Queryable } from '@agenthub/_shared'
import {
  SessionAlreadyExistsError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import { PostgresSessionPersistence } from '../src/index.ts'
import { SessionFakeDb } from './fakes.ts'

function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: SessionId('sess-0001'),
    version: 4,
    createdAt: 1_700_000_000_000,
    isSeeded: false,
    ...overrides,
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

function wired() {
  const db = new SessionFakeDb()
  // Service 基类构造只走 ctx.reflect.provide；插件装配时由 @agenthub/auth 提供 agenthub/db。
  const ctx = { reflect: { provide: () => {} } } as never
  const service = new PostgresSessionPersistence(ctx, db as unknown as Queryable)
  return { db, service }
}

describe('PostgresSessionPersistence.create', () => {
  it('落主表行（header 深快照 + inherited_event_count），handle 为 write 且游标 0', async () => {
    const { db, service } = wired()
    const handle = await service.create(header())
    expect(handle.access).toBe('write')
    expect(handle.inheritedEventCount).toBe(SessionLogOffset(0))
    const insert = db.statements.find(item => item.text.includes('INSERT INTO agenthub_sessions'))
    expect(insert).toBeDefined()
    expect(insert?.values?.[0]).toBe('sess-0001')
    // 断言持久通道是 SQL 而非文件：全部语句均为对 agenthub 表的 SQL。
    expect(db.statements.every(item => /agenthub_sessions|agenthub_session_events/.test(item.text))).toBe(true)
    await handle.close()
  })

  it('重复 id → SessionAlreadyExistsError', async () => {
    const { service } = wired()
    await service.create(header())
    await expect(service.create(header())).rejects.toThrow(SessionAlreadyExistsError)
  })

  it('契约校验：非 seeded 带前缀长度拒绝；seeded 缺前缀长度拒绝', async () => {
    const { service } = wired()
    await expect(
      service.create(header(), { inheritedEventCount: SessionLogOffset(3) }),
    ).rejects.toThrow(TypeError)
    await expect(
      service.create(header({ isSeeded: true })),
    ).rejects.toThrow(TypeError)
  })
})

describe('PostgresSessionPersistence.open / handle', () => {
  it('open 不存在 → SessionPersistenceNotFoundError', async () => {
    const { service } = wired()
    await expect(service.open(SessionId('nope'), 'read')).rejects.toThrow(SessionPersistenceNotFoundError)
  })

  it('write append 落事件表并回写 event_count；read handle 读到全量', async () => {
    const { service } = wired()
    const write = await service.create(header())
    await write.append(events(0, 3))
    const read = await service.open(SessionId('sess-0001'), 'read')
    const slice = await read.read()
    expect(slice.eventState).toBe('shared-frozen')
    expect(slice.events.map(event => event.seq)).toEqual([0, 1, 2])
    const snapshot = await service.stat(SessionId('sess-0001'))
    expect(snapshot?.eventCount).toBe(3)
    await Promise.all([write.close(), read.close()])
  })

  it('append 不连续 seq → 拒绝且不落库', async () => {
    const { db, service } = wired()
    const write = await service.create(header())
    await expect(write.append(events(2, 1))).rejects.toThrow(/append seq mismatch/)
    expect(db.statements.some(item => item.text.includes('INSERT INTO agenthub_session_events'))).toBe(false)
    await write.close()
  })

  it('read handle 拒绝 append/flush', async () => {
    const { service } = wired()
    const write = await service.create(header())
    await write.append(events(0, 1))
    const read = await service.open(SessionId('sess-0001'), 'read')
    await expect(read.append(events(1, 1))).rejects.toThrow(SessionReadOnlyError)
    await expect(read.flush()).rejects.toThrow(SessionReadOnlyError)
    await Promise.all([write.close(), read.close()])
  })

  it('单写者：活跃 write handle 在册时第二个 write open 拒绝；close 后可重获', async () => {
    const { service } = wired()
    const first = await service.create(header())
    await expect(service.open(SessionId('sess-0001'), 'write')).rejects.toThrow(Error)
    await first.close()
    const second = await service.open(SessionId('sess-0001'), 'write')
    await second.append(events(0, 1))
    await second.close()
  })

  it('close 幂等；closed 后所有操作拒绝', async () => {
    const { service } = wired()
    const handle = await service.create(header())
    await handle.close()
    await handle.close()
    await expect(handle.append(events(0, 1))).rejects.toThrow(SessionHandleClosedError)
    await expect(handle.read()).rejects.toThrow(SessionHandleClosedError)
    await expect(handle.flush()).rejects.toThrow(SessionHandleClosedError)
  })

  it('offset/length 切片；越过末尾返回空', async () => {
    const { service } = wired()
    const write = await service.create(header())
    await write.append(events(0, 5))
    const read = await service.open(SessionId('sess-0001'), 'read')
    expect((await read.read(2, 2)).events.map(event => event.seq)).toEqual([2, 3])
    expect((await read.read(5)).events).toEqual([])
    await Promise.all([write.close(), read.close()])
  })
})

describe('PostgresSessionPersistence.stat / list / flush', () => {
  it('stat 不存在 → undefined；list 返回全部会话；service.flush 解析', async () => {
    const { service } = wired()
    expect(await service.stat(SessionId('nope'))).toBeUndefined()
    const handle = await service.create(header({ id: SessionId('sess-a') }))
    await handle.close()
    const other = await service.create(header({ id: SessionId('sess-b') }))
    await other.append(events(0, 1))
    await other.close()
    const list = await service.list()
    expect(list.map(item => item.header.id).sort()).toEqual(['sess-a', 'sess-b'])
    expect(list.every(item => /^\d+$/.test(item.revision))).toBe(true)
    await expect(service.flush()).resolves.toBeUndefined()
  })
})
