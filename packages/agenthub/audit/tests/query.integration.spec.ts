/**
 * 审计查询 · 真实数据库隔离（阶段 C3-B / `QA-1` V4 / `BND-4`）。
 *
 * 单测只能证明 SQL 里带了 `project_id` 条件；本文件在真库上证明**另一个项目的
 * 记录一条都取不到**。方案书原文用 testcontainers，仓库无该依赖，改为经
 * `AGENTHUB_TEST_DATABASE_URL` 连本地 PG（与既有集成测试同口径）。
 *
 * @module tests/query.integration.spec
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditService } from '../src/index.ts'

const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL

describe.skipIf(integrationUrl === undefined)('审计查询 · 真库跨项目隔离（V4 / BND-4）', () => {
  const pool = new Pool({ connectionString: integrationUrl })
  const service = new AuditService(pool, () => null)
  const marker = `audit-it-${randomUUID()}`
  const projectA = randomUUID()
  const projectB = randomUUID()
  /** projects.created_by 是 NOT NULL FK(users)；本测试自建一个只属于它的用户。 */
  const ownerId = randomUUID()

  beforeAll(async () => {
    await pool.query(
      'INSERT INTO users (id, email, display_name, status, password_hash) VALUES ($1, $2, $3, \'active\', $4)',
      [ownerId, `${marker}@test.local`, marker, 'not-a-real-hash'],
    )
    // 审计行的 project_id 有 FK；先建两个只用于本测试的项目。
    for (const id of [projectA, projectB]) {
      await pool.query(
        'INSERT INTO projects (id, name, description, status, harness_workspace_id, created_by)'
        + " VALUES ($1, $2, NULL, 'active', $3, $4)",
        [id, marker, `${marker}:${id}`, ownerId],
      )
    }
    for (const [projectId, toolName] of [[projectA, 'a_tool'], [projectB, 'b_tool']] as const) {
      await pool.query(
        'INSERT INTO audit_records (project_id, tool_name, risk_level, status, trace_id)'
        + " VALUES ($1, $2, 'read', 'ok', $3)",
        [projectId, toolName, marker],
      )
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM audit_records WHERE trace_id = $1', [marker])
    await pool.query('DELETE FROM projects WHERE name = $1', [marker])
    await pool.query('DELETE FROM users WHERE email = $1', [`${marker}@test.local`])
    await pool.end()
  })

  it('查 A 项目取不到 B 项目任何记录', async () => {
    const page = await service.listRecords({ projectId: projectA, limit: 100 })

    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every(row => row.project_id === projectA)).toBe(true)
    expect(page.items.some(row => row.tool_name === 'b_tool')).toBe(false)
  })

  it('total 与 items 同属被筛选项目（计数不越界）', async () => {
    const pageA = await service.listRecords({ projectId: projectA, limit: 100 })
    const pageB = await service.listRecords({ projectId: projectB, limit: 100 })

    expect(pageA.total).toBe(pageA.items.length)
    expect(pageB.total).toBe(pageB.items.length)
    expect(pageA.total).toBe(1)
    expect(pageB.total).toBe(1)
  })

  it('无匹配项目 → 空集且 total=0（不报错、不返回他项目数据）', async () => {
    const page = await service.listRecords({ projectId: randomUUID(), limit: 100 })

    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
  })

  it('工具名筛选在项目内生效，越界工具名取不到他项目记录', async () => {
    const inProject = await service.listRecords({ projectId: projectA, limit: 100 })
    expect(inProject.items.some(row => row.tool_name === 'b_tool')).toBe(false)
  })
})
