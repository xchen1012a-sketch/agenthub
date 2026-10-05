/**
 * 风险分级（阶段 C3-A / `BND-3` 风险默认拒绝）。
 *
 * 分级只影响**草稿的建议值**：拿不到结论时回落到最保守的 `read` 且**必须**记入
 * 回执（不静默），导入本身不被阻断。关闭分级时**一次 LLM 都不调**。
 *
 * @module tests/risk-classifier.spec
 */
import { describe, expect, it } from 'vitest'
import type { RiskClassifier, RiskLevel } from '../src/index.ts'
import { FakeIngestDb, withDb } from './fakes.ts'

/** 一个只含单个 operation 的最小文档。 */
function doc(operationId: string, summary: string): unknown {
  return {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    paths: {
      '/orders': {
        post: { operationId, summary, responses: { 200: { description: 'ok' } } },
      },
    },
  }
}

/** 分级替身：记录调用并回放给定结果；`throwMessage` 非空表示模拟 LLM 失败。 */
function classifier(result: RiskLevel, throwMessage?: string): {
  calls: { name: string; description: string }[]
  classify: RiskClassifier
} {
  const calls: { name: string; description: string }[] = []
  const classify: RiskClassifier = async (input) => {
    calls.push({ name: input.name, description: input.description })
    if (throwMessage !== undefined) throw new Error(throwMessage)
    return result
  }
  return { calls, classify }
}

/** 读取 FakeIngestDb 中最后一行的落库参数（INSERT 的 values 顺序即列顺序）。 */
function lastInsert(db: FakeIngestDb): readonly unknown[] {
  const statement = [...db.statements].reverse().find(item => item.text.startsWith('INSERT INTO tools'))
  expect(statement).toBeDefined()
  return statement?.values ?? []
}

describe('风险分级 · 拿到结论时按 LLM 判定落库', () => {
  it('critical → 草稿 risk_level=critical（不再一律 read）', async () => {
    const db = new FakeIngestDb()
    const stub = classifier('critical')
    const service = withDb(db, { classifyRisk: stub.classify })

    await service.ingestFromJson(doc('deleteOrder', '删除订单'))

    const values = lastInsert(db)
    expect(values).toContain('critical')
  })

  it('分级收到 operationId 与 summary（模型要看到真实语义才判得准）', async () => {
    const db = new FakeIngestDb()
    const stub = classifier('write')
    const service = withDb(db, { classifyRisk: stub.classify })

    await service.ingestFromJson(doc('updateOrder', '修改订单金额'))

    expect(stub.calls[0]).toMatchObject({ name: 'updateOrder', description: '修改订单金额' })
  })
})

describe('风险分级 · 拿不到结论时 fail-closed（BND-3）', () => {
  it('分级抛错 → 回落 read，且导入不被阻断、原因记入回执', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db, { classifyRisk: classifier('read', 'LLM 不可用').classify })

    const receipt = await service.ingestFromJson(doc('queryOrder', '查询订单'))

    expect(receipt.created).toEqual(['queryOrder'])
    expect(lastInsert(db)).toContain('read')
    expect(receipt.skipped).toEqual([
      { name: 'queryOrder', sourceRef: 'POST /orders', reason: 'risk_classification_failed' },
    ])
  })

  it('分级返回非法等级 → 同样回落 read 并记原因（不写入越界枚举）', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db, { classifyRisk: classifier('超级危险' as RiskLevel).classify })

    const receipt = await service.ingestFromJson(doc('queryOrder', '查询订单'))

    expect(lastInsert(db)).toContain('read')
    expect(receipt.skipped[0]?.reason).toBe('invalid_risk_level')
  })
})

describe('风险分级 · 关闭开关时完全不调 LLM', () => {
  it('未注入分级实现 → 一律 read，且不产生失败回执', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db, {})

    const receipt = await service.ingestFromJson(doc('queryOrder', '查询订单'))

    expect(lastInsert(db)).toContain('read')
    expect(receipt.created).toEqual(['queryOrder'])
    expect(receipt.skipped).toEqual([])
  })
})

describe('风险分级 · 输出枚举受架构约束', () => {
  it('RiskLevel 的值域与 tools.risk_level CHECK 一致（四枚举）', () => {
    // 编译期约束：下面四行任一越界都会让类型检查失败（越界值不得进库）。
    const levels: readonly RiskLevel[] = ['read', 'write', 'sensitive', 'critical']
    expect([...levels].sort()).toEqual(['critical', 'read', 'sensitive', 'write'])
  })
})
