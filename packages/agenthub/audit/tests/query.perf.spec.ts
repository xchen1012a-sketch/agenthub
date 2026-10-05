/**
 * 审计查询性能门槛（阶段 C3 实测补全 / 方案书 §6「p95 ≤ 500ms（10k 行级）」）。
 *
 * 单测只证明 SQL 形状；本文件在**真库 10k 行**上量 p95，回答"审计页在真实规模下
 * 是否还能用"。种子数据挂在自建项目下，`afterAll` 按 project_id 清理。
 *
 * 无 `AGENTHUB_TEST_DATABASE_URL` 时整体跳过；跳过不等于通过（`QA-5`）。
 *
 * @module tests/query.perf.spec
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditService } from '../src/index.ts'

const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL

/** 方案书 §6 的性能门槛（毫秒）。 */
const P95_BUDGET_MS = 500
/** 种子规模：审计页按 1 万行级评估。 */
const SEED_ROWS = 10_000
/** 单页条数（与 ui 的 PAGE_SIZE 同口径）。 */
const PAGE_SIZE = 50
/** 采样次数（取 p95）。 */
const SAMPLES = 20

describe.skipIf(integrationUrl === undefined)('审计查询 · 10k 行性能门槛（真库）', () => {
  const pool = new Pool({ connectionString: integrationUrl })
  const service = new AuditService(pool, () => null)
  const projectId = randomUUID()
  const ownerId = randomUUID()
  const email = `audit-perf-${randomUUID()}@test.local`

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO users (id, email, display_name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)",
      [ownerId, email, email, 'not-a-real-hash'],
    )
    await pool.query(
      'INSERT INTO projects (id, name, description, status, harness_workspace_id, created_by)'
      + " VALUES ($1, $2, NULL, 'active', $3, $4)",
      [projectId, email, `perf:${projectId}`, ownerId],
    )
    // 一条 INSERT ... SELECT generate_series 造 10k 行：状态按四枚举轮转，时间戳递增。
    await pool.query(
      'INSERT INTO audit_records (project_id, user_id, tool_name, risk_level, status, trace_id, created_at)'
      + " SELECT $1, $2, 'perf_tool_' || (g % 7), 'read',"
      + " (ARRAY['ok','error','denied','pending'])[1 + (g % 4)],"
      + " 'perf-' || g, now() - (g || ' seconds')::interval"
      + ' FROM generate_series(1, $3) AS g',
      [projectId, ownerId, SEED_ROWS],
    )
  }, 120_000)

  afterAll(async () => {
    await pool.query('DELETE FROM audit_records WHERE project_id = $1', [projectId])
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId])
    await pool.query('DELETE FROM users WHERE id = $1', [ownerId])
    await pool.end()
  })

  /** 量一次分页查询耗时（毫秒）。 */
  async function timePage(offset: number): Promise<number> {
    const started = performance.now()
    await service.listRecords({ projectId, limit: PAGE_SIZE, offset })
    return performance.now() - started
  }

  /** 采样并取 p95。 */
  function p95(samples: readonly number[]): number {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  }

  it('种子行数符合预期（否则性能结论无效）', async () => {
    const { rows } = await pool.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM audit_records WHERE project_id = $1',
      [projectId],
    )
    expect(Number(rows[0]?.total)).toBe(SEED_ROWS)
  })

  it(`首页查询 p95 ≤ ${String(P95_BUDGET_MS)}ms（${String(SEED_ROWS)} 行）`, async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLES; i += 1) samples.push(await timePage(0))
    const measured = p95(samples)
    console.log(`首页 p95 = ${measured.toFixed(1)}ms（${String(SEED_ROWS)} 行 / ${String(SAMPLES)} 次采样）`)
    expect(measured).toBeLessThanOrEqual(P95_BUDGET_MS)
  })

  it(`末页查询 p95 ≤ ${String(P95_BUDGET_MS)}ms（OFFSET 深处）`, async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLES; i += 1) samples.push(await timePage(SEED_ROWS - PAGE_SIZE))
    const measured = p95(samples)
    console.log(`末页 p95 = ${measured.toFixed(1)}ms（OFFSET ${String(SEED_ROWS - PAGE_SIZE)}）`)
    expect(measured).toBeLessThanOrEqual(P95_BUDGET_MS)
  })

  it('带 status 筛选的 p95 也达标（走同一索引路径）', async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now()
      await service.listRecords({ projectId, status: 'denied', limit: PAGE_SIZE, offset: 0 })
      samples.push(performance.now() - started)
    }
    const measured = p95(samples)
    console.log(`status 筛选 p95 = ${measured.toFixed(1)}ms`)
    expect(measured).toBeLessThanOrEqual(P95_BUDGET_MS)
  })
})
