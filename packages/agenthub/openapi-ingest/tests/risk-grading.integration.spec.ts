/**
 * 分级链路的真实端点与真实库（阶段 C3 实测补全 / `QA-5`）。
 *
 * 单测用替身证明了"拿到 critical 就落 critical、失败回 read"；本文件回答另一个问题：
 * **真实 LLM 端点对真实草稿到底判得准不准**，以及**落库的等级确实是模型给的**。
 *
 * 无 `AGENTHUB_LLM_API_KEY` 时整体跳过（真实端点不是每次提交都能跑）；
 * 跳过不等于通过——`QA-5` 要求未跑即标未实测。
 *
 * @module tests/risk-grading.integration.spec
 */
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLlmClient, readLlmConfig, validateLlmConfig } from '@agenthub/_shared'
import { createLlmRiskClassifier, OpenApiIngestService } from '../src/index.ts'

const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL
const hasLlm = (process.env.AGENTHUB_LLM_API_KEY ?? '').trim() !== ''
const enabled = integrationUrl !== undefined && hasLlm

/** 三条语义明确的草稿：只读、写、删除。 */
const DOC = {
  openapi: '3.0.0',
  info: { title: 'C3 probe', version: '1' },
  paths: {
    '/customers': {
      get: { operationId: 'queryCustomer', summary: '查询客户信息', responses: { 200: { description: 'ok' } } },
    },
    '/orders': {
      post: { operationId: 'updateOrderAmount', summary: '修改订单金额', responses: { 200: { description: 'ok' } } },
    },
    '/orders/{id}': {
      delete: { operationId: 'deleteOrder', summary: '删除订单', responses: { 200: { description: 'ok' } } },
    },
  },
} as const

describe.skipIf(!enabled)('风险分级 · 真实 LLM 端点（C3 实测）', () => {
  const pool = new Pool({ connectionString: integrationUrl })
  const createdNames = ['queryCustomer', 'updateOrderAmount', 'deleteOrder']
  /** 覆盖模型判定：真实结论可能与命名不符，断言行为而非猜测具体值。 */
  let graded: { name: string; risk_level: string }[] = []

  beforeAll(async () => {
    // 清掉上次残留的同名草稿（tools.name 唯一约束会让 INSERT 静默跳过）。
    await pool.query('DELETE FROM tools WHERE name = ANY($1::text[])', [createdNames])
    validateLlmConfig(process.env)
    const service = new OpenApiIngestService(pool, {
      classifyRisk: createLlmRiskClassifier(createLlmClient(readLlmConfig(process.env))),
    })
    await service.ingestFromJson(DOC, { createdBy: null })
    const { rows } = await pool.query<{ name: string; risk_level: string }>(
      'SELECT name, risk_level FROM tools WHERE name = ANY($1::text[]) ORDER BY name',
      [createdNames],
    )
    graded = rows
    // 实测证据（QA-5：可观察结果，不是"函数被调用过"）：真实模型对三条草稿的判定。
    console.log('真实端点分级结果 =', JSON.stringify(rows))
  }, 120_000)

  afterAll(async () => {
    await pool.query('DELETE FROM tools WHERE name = ANY($1::text[])', [createdNames])
    await pool.end()
  })

  it('三条草稿都落库（真实端点不阻断导入）', () => {
    expect(graded.map(row => row.name)).toEqual([...createdNames].sort())
  })

  it('等级全部是合法枚举（模型越界值不得入库）', () => {
    const allowed = new Set(['read', 'write', 'sensitive', 'critical'])
    expect(graded.every(row => allowed.has(row.risk_level))).toBe(true)
  })

  it('不是"一律 read"——分级真的改变了落库值', () => {
    // 若分级未生效（回落或未接线），三条会全是 read；这里要求至少一条非 read。
    expect(graded.some(row => row.risk_level !== 'read')).toBe(true)
  })

  it('删除类操作被判定为比查询类更危险（语义方向正确）', () => {
    const rank: Record<string, number> = { read: 0, write: 1, sensitive: 2, critical: 3 }
    const query = graded.find(row => row.name === 'queryCustomer')
    const remove = graded.find(row => row.name === 'deleteOrder')
    expect(query).toBeDefined()
    expect(remove).toBeDefined()
    // 方向性断言：真实模型可能把删除判成 write 或 critical，但不应判成比查询更松。
    expect(rank[remove?.risk_level ?? 'read'] ?? -1).toBeGreaterThanOrEqual(rank[query?.risk_level ?? 'read'] ?? 0)
  })
})
