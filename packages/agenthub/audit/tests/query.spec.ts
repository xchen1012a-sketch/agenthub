/**
 * 审计查询（阶段 C3-B / `.ai-spec/00-boundaries.md` BND-4 跨项目零泄漏）。
 *
 * 查询面**恒带 project 归属**：调用方给的项目之外的记录一条都取不到。
 * 五维筛选 + 分页；`status` 只认四枚举（细分原因仍在 `result_meta.reason`，D16）。
 *
 * @module tests/query.spec
 */
import { describe, expect, it } from 'vitest'
import { AgenthubError, type Queryable } from '@agenthub/_shared'
import { AuditService, STATUSES } from '../src/index.ts'

interface Captured {
  text: string
  values: readonly unknown[]
}

/** 记录 SQL 与参数并回放固定行数；用于断言查询形状而非数据库行为。 */
function dbStub(rows: readonly Record<string, unknown>[] = [], count = rows.length): {
  db: Queryable
  captured: Captured[]
} {
  const captured: Captured[] = []
  return {
    captured,
    db: {
      async query(text: string, values?: readonly unknown[]) {
        captured.push({ text, values: values ?? [] })
        return { rows: text.includes('COUNT(*)') ? [{ total: String(count) }] : [...rows] }
      },
    } as unknown as Queryable,
  }
}

const service = (db: Queryable): AuditService => new AuditService(db, () => null)

describe('AuditService.listRecords · 恒带项目归属（BND-4）', () => {
  it('查询条件里始终带 project_id（不是可选筛选）', async () => {
    const stub = dbStub()
    await service(stub.db).listRecords({ projectId: 'p-1' })

    const select = stub.captured.find(item => item.text.includes('SELECT'))?.text ?? ''
    expect(select).toContain('project_id = $1')
    expect(stub.captured[0]?.values[0]).toBe('p-1')
  })

  it('仅给 projectId 时不附加其他 WHERE 条件', async () => {
    const stub = dbStub()
    await service(stub.db).listRecords({ projectId: 'p-1' })

    const select = stub.captured.find(item => item.text.includes('SELECT'))?.text ?? ''
    expect(select).not.toContain('user_id =')
    expect(select).not.toContain('status =')
  })
})

describe('AuditService.listRecords · 五维筛选', () => {
  it('userId / toolId / status / 时间范围各自进 WHERE，且参数顺序稳定', async () => {
    const stub = dbStub()
    await service(stub.db).listRecords({
      projectId: 'p-1',
      userId: 'u-1',
      toolId: 't-1',
      status: 'denied',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    })

    const select = stub.captured.find(item => item.text.includes('SELECT'))?.text ?? ''
    expect(select).toContain('project_id = $1')
    expect(select).toContain('user_id = $2')
    expect(select).toContain('tool_id = $3')
    expect(select).toContain('status = $4')
    expect(select).toContain('created_at >= $5')
    expect(select).toContain('created_at <= $6')
    expect(stub.captured.find(item => item.text.includes('SELECT'))?.values).toEqual([
      'p-1', 'u-1', 't-1', 'denied', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
    ])
  })

  it('只给 from 时不到 to 的边界（半开区间可选）', async () => {
    const stub = dbStub()
    await service(stub.db).listRecords({ projectId: 'p-1', from: '2026-10-01T00:00:00.000Z' })

    const select = stub.captured.find(item => item.text.includes('SELECT'))?.text ?? ''
    expect(select).toContain('created_at >=')
    expect(select).not.toContain('created_at <=')
  })
})

describe('AuditService.listRecords · 分页', () => {
  it('limit / offset 作为独立参数绑定（不拼进 SQL 文本）', async () => {
    const stub = dbStub([], 42)
    await service(stub.db).listRecords({ projectId: 'p-1', limit: 50, offset: 100 })

    const page = stub.captured.find(item => item.text.includes('SELECT') && !item.text.includes('COUNT(*)'))
    const select = page?.text ?? ''
    expect(select).toContain('LIMIT')
    expect(select).toContain('OFFSET')
    expect(select).not.toContain('LIMIT 50')
    expect(page?.values).toEqual(['p-1', 50, 100])
  })

  it('返回 total 为计数查询结果（供页面算总页数）', async () => {
    const stub = dbStub([{ id: 'a-1' }], 42)
    const page = await service(stub.db).listRecords({ projectId: 'p-1' })

    expect(page.total).toBe(42)
    expect(page.items).toEqual([{ id: 'a-1' }])
  })

  it('计数查询与数据查询用同一套 WHERE 与参数（除 LIMIT/OFFSET）', async () => {
    const stub = dbStub([], 7)
    await service(stub.db).listRecords({ projectId: 'p-1', status: 'error', limit: 10, offset: 20 })

    const count = stub.captured.find(item => item.text.includes('COUNT(*)'))
    const page = stub.captured.find(item => item.text.includes('SELECT') && !item.text.includes('COUNT(*)'))
    expect(count?.values).toEqual(['p-1', 'error'])
    expect(page?.values).toEqual(['p-1', 'error', 10, 20])
  })
})

describe('AuditService.listRecords · 状态枚举受约束', () => {
  it('STATUSES 只含四枚举（与 audit_records.status CHECK 一致）', () => {
    expect([...STATUSES].sort()).toEqual(['denied', 'error', 'ok', 'pending'])
  })

  it('非法 status → 抛 AgenthubError（与路由/消费者共用同一套错误契约）', async () => {
    const stub = dbStub()
    const error = await service(stub.db)
      .listRecords({ projectId: 'p-1', status: 'whatever' as 'ok' })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AgenthubError)
    expect((error as AgenthubError).code).toBe('agenthub/audit/InvalidStatus')
  })
})
