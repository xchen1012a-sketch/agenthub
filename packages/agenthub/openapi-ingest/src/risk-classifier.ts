/**
 * LLM 侧风险分级器（阶段 C3-A）：让模型按 JSON 返回等级，只接受四枚举。
 *
 * **为什么必须用 JSON 而不是"回一个词"**：分级走 `completeJson`，该客户端强制
 * `response_format: { type: 'json_object' }`；真实端点（DeepSeek）要求提示词里
 * 出现 `json` 字样，否则直接 400 ——
 * `Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'`。
 * 用"回一个词"的提示词会让分级在**生产环境全程失败并静默回落 `read`**（实测踩过）。
 * JSON 形态同时消掉了"从自由文本里抠等级"的歧义（`reread` / `OVERWRITE` 之类）。
 *
 * 不在这里做降级——拿不到合法结论时抛错，由 `OpenApiIngestService` 统一回落 `read`
 * 并记入回执（降级策略只有一处，避免两处各降一半）。
 *
 * @module @agenthub/openapi-ingest/risk-classifier
 */
import type { LlmClient } from '@agenthub/_shared'
import { isRiskLevel, type RiskClassificationInput, type RiskLevel } from './service.ts'

/**
 * 分级提示词。两点是硬要求，改动前先看本文件顶部说明：
 * ① 必须出现 `json` 字样；② 必须写明字段名与四枚举，让模型在值域内选。
 */
const SYSTEM_PROMPT = [
  '你是 API 风险分级器。根据操作的名称与描述，判断它对业务数据的破坏力。',
  '以 json 返回，且只返回这一个 json 对象，不要解释：{"riskLevel":"<等级>"}',
  'riskLevel 只能是下列四个之一：',
  'read —— 只读，不改变任何数据',
  'write —— 新增或修改数据，可回滚',
  'sensitive —— 涉及金额、权限、隐私、批量导出等敏感数据',
  'critical —— 删除、不可逆、或影响面很大的操作',
].join('\n')

/**
 * 构造 LLM 侧分级器。
 * @param llm - LLM 客户端（`completeJson` 已强制 JSON 模式）。
 * @returns 分级端口实现；模型未给出合法 `riskLevel` 时抛错（由调用方回落 `read`）。
 */
export function createLlmRiskClassifier(llm: LlmClient): (input: RiskClassificationInput) => Promise<RiskLevel> {
  return async (input) => {
    const answer = await llm.completeJson(SYSTEM_PROMPT, `name: ${input.name}\ndescription: ${input.description}`)
    // 只认字段：缺字段或不合法都抛错，避免"从描述文本里猜等级"这种误判来源。
    const raw = typeof answer === 'object' && answer !== null && 'riskLevel' in answer
      ? answer.riskLevel
      : undefined
    if (!isRiskLevel(raw)) {
      throw new Error(`风险分级未返回合法 riskLevel：${JSON.stringify(answer).slice(0, 120)}`)
    }
    return raw
  }
}
