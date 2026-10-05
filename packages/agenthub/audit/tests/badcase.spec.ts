/**
 * 坏例登记与销号（P5 阶段书 §7.1-2）。
 *
 * 用假 DB 固定 SQL 回放，断言"从入参到落库语句"的行为与边界：
 * 幂等（同一审计记录重复登记不得产生第二行）、归属校验（`BND-4`）、
 * 非法类别拒绝、以及销号只对未销号行生效。
 *
 * @module tests/badcase.spec
 */
import { describe, expect, it } from 'vitest'
import { AgenthubError, type Queryable } from '@agenthub/_shared'
import { AuditService } from '../src/index.ts'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222'
const AUDIT = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'

interface Call {
  readonly text: string
  readonly values: readonly unknown[]
}

/**
 * 按 SQL 特征回放结果的假 DB。
 * @param handler - 依据语句与参数返回行。
 * @returns 假 DB 与调用记录。
 */
function fakeDb(
  handler: (text: string, values: readonly unknown[]) => readonly Record<string, unknown>[],
): { db: Queryable; calls: Call[] } {
  const calls: Call[] = []
  const db = {
    async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
      calls.push({ text, values })
      return { rows: [...handler(text, values)] }
    },
  } as unknown as Queryable
  return { db, calls }
}

/** 一条存在的审计记录。 */
function auditExists(): readonly Record<string, unknown>[] {
  return [{ id: AUDIT }]
}

describe('AuditService.markBadcase', () => {
  it('正常登记：插入一行并回读', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('FROM audit_records')) return auditExists()
      if (text.includes('INSERT INTO badcases')) {
        return [{ id: 'bc-1', audit_id: AUDIT, category: 'wrong_tool', resolved: false }]
      }
      return []
    })

    const row = await new AuditService(db, () => null).markBadcase({
      auditId: AUDIT,
      projectId: PROJECT,
      category: 'wrong_tool',
      note: '调错了工具',
      markedBy: USER,
    })

    expect(row.category).toBe('wrong_tool')
    const insert = calls.find(call => call.text.includes('INSERT INTO badcases'))
    expect(insert).toBeDefined()
    expect(insert?.values).toContain('wrong_tool')
    expect(insert?.values).toContain('调错了工具')
  })

  it('幂等：重复登记用 ON CONFLICT 更新既有行，不产生第二行', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('FROM audit_records')) return auditExists()
      if (text.includes('INSERT INTO badcases')) {
        return [{ id: 'bc-1', audit_id: AUDIT, category: 'bad_param', resolved: false }]
      }
      return []
    })

    await new AuditService(db, () => null).markBadcase({
      auditId: AUDIT,
      projectId: PROJECT,
      category: 'bad_param',
      markedBy: USER,
    })

    const insert = calls.find(call => call.text.includes('INSERT INTO badcases'))
    expect(insert?.text).toMatch(/ON CONFLICT\s*\(\s*audit_id\s*\)/i)
    expect(insert?.text).toMatch(/DO UPDATE/i)
  })

  it('销号状态在重新登记时被清空（新判定覆盖旧结论）', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('FROM audit_records')) return auditExists()
      if (text.includes('INSERT INTO badcases')) return [{ id: 'bc-1', resolved: false }]
      return []
    })

    await new AuditService(db, () => null).markBadcase({
      auditId: AUDIT,
      projectId: PROJECT,
      category: 'timeout',
      markedBy: USER,
    })

    const insert = calls.find(call => call.text.includes('INSERT INTO badcases'))
    expect(insert?.text).toMatch(/resolved\s*=\s*FALSE/i)
    expect(insert?.text).toMatch(/resolved_by\s*=\s*NULL/i)
  })

  it('跨项目：审计记录不属于该项目 → 拒绝且不写入', async () => {
    const { db, calls } = fakeDb(() => [])

    await expect(
      new AuditService(db, () => null).markBadcase({
        auditId: AUDIT,
        projectId: OTHER_PROJECT,
        category: 'wrong_tool',
        markedBy: USER,
      }),
    ).rejects.toThrow(AgenthubError)

    expect(calls.some(call => call.text.includes('INSERT INTO badcases'))).toBe(false)
  })

  it('归属校验的 SQL 带 projectId（BND-4：不依赖调用方自觉）', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('FROM audit_records')) return auditExists()
      if (text.includes('INSERT INTO badcases')) return [{ id: 'bc-1' }]
      return []
    })

    await new AuditService(db, () => null).markBadcase({
      auditId: AUDIT,
      projectId: PROJECT,
      category: 'wrong_tool',
      markedBy: USER,
    })

    const guard = calls.find(call => call.text.includes('FROM audit_records'))
    expect(guard?.text).toMatch(/project_id\s*=/)
    expect(guard?.values).toContain(PROJECT)
    expect(guard?.values).toContain(AUDIT)
  })

  it('非法类别 → 400 且不写入', async () => {
    const { db, calls } = fakeDb(() => auditExists())

    await expect(
      new AuditService(db, () => null).markBadcase({
        auditId: AUDIT,
        projectId: PROJECT,
        category: 'not_a_cause' as never,
        markedBy: USER,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 })

    expect(calls.some(call => call.text.includes('INSERT INTO badcases'))).toBe(false)
  })
})

describe('AuditService.resolveBadcase', () => {
  it('销号成功：写 resolved / resolved_by / resolved_at', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('UPDATE badcases')) return [{ id: 'bc-1', resolved: true }]
      return []
    })

    const row = await new AuditService(db, () => null).resolveBadcase('bc-1', PROJECT, USER)

    expect(row?.resolved).toBe(true)
    const update = calls.find(call => call.text.includes('UPDATE badcases'))
    expect(update?.text).toMatch(/resolved\s*=\s*TRUE/i)
    expect(update?.values).toContain(USER)
  })

  it('只对未销号行生效（重复销号不改 resolved_at）', async () => {
    const { db, calls } = fakeDb(() => [{ id: 'bc-1' }])

    await new AuditService(db, () => null).resolveBadcase('bc-1', PROJECT, USER)

    const update = calls.find(call => call.text.includes('UPDATE badcases'))
    expect(update?.text).toMatch(/resolved\s*=\s*FALSE/i)
  })

  it('归属校验：SQL 以 project_id 关联 audit_records（BND-4）', async () => {
    const { db, calls } = fakeDb(() => [{ id: 'bc-1' }])

    await new AuditService(db, () => null).resolveBadcase('bc-1', PROJECT, USER)

    const update = calls.find(call => call.text.includes('UPDATE badcases'))
    expect(update?.text).toMatch(/FROM audit_records/)
    expect(update?.values).toContain(PROJECT)
  })

  it('跨项目或不存在 → 返回 null（不报错，不泄漏存在性）', async () => {
    const { db } = fakeDb(() => [])

    await expect(new AuditService(db, () => null).resolveBadcase('bc-x', OTHER_PROJECT, USER)).resolves.toBeNull()
  })
})
