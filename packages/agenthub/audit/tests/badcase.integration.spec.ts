/**
 * 坏例登记的真库行为（P5 阶段书 §7.1-2）。
 *
 * 单测用假 DB 覆盖不到**唯一约束**与 `ON CONFLICT` 的真实语义，本文件在真库上
 * 锁住两点：① 同一审计记录重复登记只留一行且被更新；② 销号后再登记会清空销号。
 *
 * 依赖 `AGENTHUB_TEST_DATABASE_URL`；未设置时跳过（**跳过不等于通过**）。
 *
 * @module tests/badcase.integration.spec
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Queryable } from '@agenthub/_shared'
import { AuditService } from '../src/index.ts'

const url = process.env.AGENTHUB_TEST_DATABASE_URL
const enabled = url !== undefined

describe.skipIf(!enabled)('坏例登记真库行为', () => {
  const pool = new Pool({ connectionString: url })
  const db = pool as unknown as Queryable
  const service = new AuditService(db, () => null)

  const projectId = randomUUID()
  const ownerId = randomUUID()
  const auditId = randomUUID()
  const marker = `c5-badcase-${randomUUID()}`

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO users (id, email, display_name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)",
      [ownerId, `${marker}@test.local`, marker, 'not-a-real-hash'],
    )
    await pool.query(
      'INSERT INTO projects (id, name, description, status, harness_workspace_id, created_by)'
      + " VALUES ($1, $2, NULL, 'active', $3, $4)",
      [projectId, marker, `c5:${projectId}`, ownerId],
    )
    await pool.query(
      'INSERT INTO audit_records (id, project_id, user_id, session_id, tool_name, risk_level, status, trace_id)'
      + " VALUES ($1, $2, $3, 's-1', 'probe_tool', 'read', 'error', $4)",
      [auditId, projectId, ownerId, `${marker}-trace`],
    )
  }, 120_000)

  afterAll(async () => {
    await pool.query('DELETE FROM badcases WHERE audit_id = $1', [auditId])
    await pool.query('DELETE FROM audit_records WHERE id = $1', [auditId])
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId])
    await pool.query('DELETE FROM users WHERE id = $1', [ownerId])
    await pool.end()
  })

  it('重复登记只留一行，且最新判定覆盖旧判定', async () => {
    await service.markBadcase({ auditId, projectId, category: 'wrong_tool', note: '第一次', markedBy: ownerId })
    await service.markBadcase({ auditId, projectId, category: 'bad_param', note: '第二次', markedBy: ownerId })

    const { rows } = await pool.query<{ category: string; category_note: string }>(
      'SELECT category, category_note FROM badcases WHERE audit_id = $1',
      [auditId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.category).toBe('bad_param')
    expect(rows[0]?.category_note).toBe('第二次')
  })

  it('销号后再登记 → 销号状态被清空（新判定覆盖旧结论）', async () => {
    const before = await pool.query<{ id: string }>('SELECT id FROM badcases WHERE audit_id = $1', [auditId])
    const badcaseId = before.rows[0]?.id ?? ''
    const resolved = await service.resolveBadcase(badcaseId, projectId, ownerId)
    expect(resolved?.resolved).toBe(true)

    await service.markBadcase({ auditId, projectId, category: 'timeout', markedBy: ownerId })

    const { rows } = await pool.query<{ resolved: boolean; resolved_by: string | null; resolved_at: Date | null }>(
      'SELECT resolved, resolved_by, resolved_at FROM badcases WHERE audit_id = $1',
      [auditId],
    )
    expect(rows[0]?.resolved).toBe(false)
    expect(rows[0]?.resolved_by).toBeNull()
    expect(rows[0]?.resolved_at).toBeNull()
  })

  it('跨项目登记被拒（审计记录不属于该项目）', async () => {
    const foreign = randomUUID()
    await expect(
      service.markBadcase({ auditId, projectId: foreign, category: 'wrong_tool', markedBy: ownerId }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it('重复销号不改写首次销号时间（resolved_at 保持不变）', async () => {
    const before = await pool.query<{ id: string }>('SELECT id FROM badcases WHERE audit_id = $1', [auditId])
    const badcaseId = before.rows[0]?.id ?? ''
    await service.resolveBadcase(badcaseId, projectId, ownerId)
    const first = await pool.query<{ resolved_at: Date }>(
      'SELECT resolved_at FROM badcases WHERE id = $1', [badcaseId],
    )

    const again = await service.resolveBadcase(badcaseId, projectId, ownerId)

    expect(again).toBeNull()
    const second = await pool.query<{ resolved_at: Date }>(
      'SELECT resolved_at FROM badcases WHERE id = $1', [badcaseId],
    )
    expect(second.rows[0]?.resolved_at).toEqual(first.rows[0]?.resolved_at)
  })
})
