/**
 * LLM 侧风险分级器（阶段 C3-A）。
 *
 * 分级走 `completeJson`，而该客户端强制 `response_format: json_object`——
 * **真实端点要求提示词里出现 "json" 字样**，否则直接 400（实测：
 * `Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'`）。
 * 所以提示词必须写 `json` 并给出字段契约，模型也必须回 JSON；解析只认该字段。
 *
 * @module tests/llm-risk-classifier.spec
 */
import { describe, expect, it } from 'vitest'
import type { LlmClient } from '@agenthub/_shared'
import { createLlmRiskClassifier } from '../src/index.ts'

/** 只实现分级用到的 completeJson；embedTexts 不在本路径上。 */
function llmStub(answer: unknown): { client: LlmClient; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = []
  return {
    calls,
    client: {
      embedTexts: () => Promise.reject(new Error('本路径不应调用向量化')),
      completeJson: (system, user) => {
        calls.push({ system, user })
        return Promise.resolve(answer)
      },
    },
  }
}

describe('createLlmRiskClassifier · 提示词满足 json_object 的硬性要求', () => {
  it('提示词出现 json（否则真实端点 400）', () => {
    const stub = llmStub({ riskLevel: 'read' })
    void createLlmRiskClassifier(stub.client)({ name: 'n', description: 'd' })
    expect(stub.calls[0]?.system.toLowerCase()).toContain('json')
  })

  it('提示词给出字段名 riskLevel 与四枚举（模型只在该值域内选）', () => {
    const stub = llmStub({ riskLevel: 'read' })
    void createLlmRiskClassifier(stub.client)({ name: 'n', description: 'd' })
    const system = stub.calls[0]?.system ?? ''
    expect(system).toContain('riskLevel')
    for (const level of ['read', 'write', 'sensitive', 'critical']) expect(system).toContain(level)
  })

  it('把草稿名与描述交给 completeJson', async () => {
    const stub = llmStub({ riskLevel: 'critical' })
    await createLlmRiskClassifier(stub.client)({ name: 'deleteOrder', description: '删除订单' })
    expect(stub.calls[0]?.user).toContain('deleteOrder')
    expect(stub.calls[0]?.user).toContain('删除订单')
  })
})

describe('createLlmRiskClassifier · 只认 riskLevel 字段', () => {
  it('合法 JSON → 返回该等级', async () => {
    const stub = llmStub({ riskLevel: 'critical' })
    await expect(createLlmRiskClassifier(stub.client)({ name: 'n', description: 'd' })).resolves.toBe('critical')
  })

  it('字段值越界 → 抛错（不写入越界枚举，由调用方统一回落 read）', async () => {
    const stub = llmStub({ riskLevel: '超级危险' })
    await expect(createLlmRiskClassifier(stub.client)({ name: 'n', description: 'd' })).rejects.toThrow(/riskLevel/)
  })

  it('缺 riskLevel 字段 → 抛错（不猜测、不从描述文本里抠词）', async () => {
    const stub = llmStub({ reason: '删除订单很危险' })
    await expect(createLlmRiskClassifier(stub.client)({ name: 'n', description: 'd' })).rejects.toThrow(/riskLevel/)
  })

  it('模型调用本身失败 → 原样抛出（不吞掉上游错误）', async () => {
    const client: LlmClient = {
      embedTexts: () => Promise.reject(new Error('unused')),
      completeJson: () => Promise.reject(new Error('LLM 502')),
    }
    await expect(createLlmRiskClassifier(client)({ name: 'n', description: 'd' })).rejects.toThrow('LLM 502')
  })
})
