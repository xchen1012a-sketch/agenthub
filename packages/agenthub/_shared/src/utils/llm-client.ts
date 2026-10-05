/**
 * OpenAI 兼容 LLM / Embedding 客户端（P4 方案书阶段 A T2 / §4.2；D20 / D35）。
 *
 * AgentHub 自建，零第三方依赖（注入 fetchImpl，测试可替身）：
 * - `embedTexts`：批量向量化（`POST {embeddingBaseUrl}/embeddings`）
 * - `completeJson`：结构化补全（`POST {llmBaseUrl}/chat/completions`，`response_format=json_object`）
 *
 * 端点与密钥从环境变量读取（D20）：对话走 DeepSeek，向量化走 OpenAI 兼容端点
 * （DeepSeek 官方不提供 embedding API）。`AGENTHUB_EMBEDDING_API_KEY` 缺省回落
 * 到 `AGENTHUB_LLM_API_KEY`。
 *
 * **维度（D35）**：默认 {@link EMBEDDING_DIM}，与环境变量及迁移 `VECTOR(2048)` 一致。
 * `dimensions` 请求字段**只在显式配置了 `AGENTHUB_EMBEDDING_DIM` 时才发送**——
 * 部分端点（如火山方舟 veCot 的 `/api/coding/v3/embeddings`）不支持该参数，
 * 发送即报 `InvalidParameter`；不支持的端点请留空该变量，让模型用自身默认维度。
 * 响应维度在配置了维度时强校验，未配置时只校验同批各条长度一致。
 *
 * 任何密钥 / 凭证不得进入错误消息或日志（AgenthubError 构造期已 redact，V5）。
 *
 * @module @agenthub/_shared/utils/llm-client
 */
import { AgenthubError } from '../errors.ts'
import type { EnvLike } from './env-validator.ts'

/** 默认向量维度：与迁移 `project_memories.embedding VECTOR(2048)` 一致（database-schema §3.6）。 */
export const EMBEDDING_DIM = 2048

export const LLM_BASE_URL_VAR = 'AGENTHUB_LLM_BASE_URL'
export const LLM_MODEL_VAR = 'AGENTHUB_LLM_MODEL'
export const LLM_API_KEY_VAR = 'AGENTHUB_LLM_API_KEY'
export const EMBEDDING_BASE_URL_VAR = 'AGENTHUB_EMBEDDING_BASE_URL'
export const EMBEDDING_MODEL_VAR = 'AGENTHUB_EMBEDDING_MODEL'
export const EMBEDDING_DIM_VAR = 'AGENTHUB_EMBEDDING_DIM'
export const EMBEDDING_API_KEY_VAR = 'AGENTHUB_EMBEDDING_API_KEY'

const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_LLM_MODEL = 'deepseek-chat'
/**
 * 默认向量化端点：火山方舟 veCot 接入点 + `doubao-embedding-vision`（D35 实测）。
 * base URL 必须含版本段（客户端按 `${base}/embeddings` 拼接）。
 * 该端点**不支持** `dimensions` 参数，因此 `AGENTHUB_EMBEDDING_DIM` 应留空，
 * 由模型输出 2048 维（与迁移列一致）。
 */
const DEFAULT_EMBEDDING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
const DEFAULT_EMBEDDING_MODEL = 'doubao-embedding-vision'

/** LLM / Embedding 端点配置（readLlmConfig 的应用默认值填进缺省）。 */
export interface LlmConfig {
  llmBaseUrl: string
  llmModel: string
  llmApiKey: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKey: string
  /** 请求维度；`undefined` 表示不发送 `dimensions`（端点自定维度，D35）。 */
  embeddingDim: number | undefined
}

/** OpenAI 兼容客户端门面（project-memory 用 embedTexts；openapi-ingest 用 completeJson）。 */
export interface LlmClient {
  /** 批量向量化；返回与输入等长的向量数组，同批各条维度一致。 */
  embedTexts(texts: string[]): Promise<number[][]>
  /** 结构化 JSON 补全（风险分级等）；要求模型返回合法 JSON，解析失败抛错。 */
  completeJson(system: string, user: string): Promise<unknown>
}

function readNonBlank(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback
}

function assertHttpBaseUrl(value: string, varName: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgenthubError('agenthub/_shared/LlmBaseUrlInvalid', `${varName} 必须是合法 URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgenthubError('agenthub/_shared/LlmBaseUrlInvalid', `${varName} 仅支持 http/https`)
  }
}

/** embedding 维度（可选 env；留空表示不发送 `dimensions`；非法值抛错）。 */
function parseEmbeddingDim(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgenthubError('agenthub/_shared/EmbeddingDimInvalid', `${EMBEDDING_DIM_VAR} 必须为正整数`)
  }
  return value
}

/** 读取配置（含默认值；不做必填 / 一致性校验，校验见 validateLlmConfig）。 */
export function readLlmConfig(env: EnvLike): LlmConfig {
  const llmApiKey = readNonBlank(env[LLM_API_KEY_VAR], '')
  return {
    llmBaseUrl: readNonBlank(env[LLM_BASE_URL_VAR], DEFAULT_LLM_BASE_URL),
    llmModel: readNonBlank(env[LLM_MODEL_VAR], DEFAULT_LLM_MODEL),
    llmApiKey,
    embeddingBaseUrl: readNonBlank(env[EMBEDDING_BASE_URL_VAR], DEFAULT_EMBEDDING_BASE_URL),
    embeddingModel: readNonBlank(env[EMBEDDING_MODEL_VAR], DEFAULT_EMBEDDING_MODEL),
    embeddingApiKey: readNonBlank(env[EMBEDDING_API_KEY_VAR], llmApiKey),
    embeddingDim: parseEmbeddingDim(env[EMBEDDING_DIM_VAR]),
  }
}

/**
 * 配置一致性校验（secrets.md §4 启动校验 / D20）。
 *
 * 校验项：对话与向量化端点可解析 + LLM 密钥非空 + 显式声明的维度等于
 * {@link EMBEDDING_DIM}（与迁移列一致）。任一失败即启动失败（fail-fast）。
 *
 * 维度只在显式配置时校验：留空表示「端点自定维度」（D35），此时不做 2048 断言，
 * 因为不发送 `dimensions` 的端点，其维度真相只能由响应给出。
 */
export function validateLlmConfig(env: EnvLike): void {
  const config = readLlmConfig(env)
  if (config.llmApiKey === '') {
    throw new AgenthubError('agenthub/_shared/LlmApiKeyMissing', `${LLM_API_KEY_VAR} 未设置（secrets.md §1.1）`)
  }
  assertHttpBaseUrl(config.llmBaseUrl, LLM_BASE_URL_VAR)
  assertHttpBaseUrl(config.embeddingBaseUrl, EMBEDDING_BASE_URL_VAR)
  if (config.embeddingDim !== undefined && config.embeddingDim !== EMBEDDING_DIM) {
    throw new AgenthubError(
      'agenthub/_shared/EmbeddingDimMismatch',
      `${EMBEDDING_DIM_VAR} 若设置必须为 ${EMBEDDING_DIM}（与 project_memories.embedding VECTOR 列一致）；`
      + '端点不支持该参数时请留空',
    )
  }
}

/** 向量/补全请求的失败 → 统一 AgenthubError（不携带端点路径或密钥，仅状态码）。 */
function upstreamError(what: string, status: number): AgenthubError {
  return new AgenthubError('agenthub/_shared/LlmUpstreamError', `${what} 请求失败：HTTP ${status}`, {
    httpStatus: 502,
  })
}

async function embedTexts(config: LlmConfig, fetchImpl: typeof fetch, texts: string[]): Promise<number[][]> {
  const res = await fetchImpl(`${config.embeddingBaseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: texts,
      // 仅在显式配置维度时发送：部分端点不支持该字段，发送即 400（D35）。
      ...config.embeddingDim === undefined ? {} : { dimensions: config.embeddingDim },
    }),
  })
  if (!res.ok) throw upstreamError('embedding', res.status)
  const body = await res.json() as { data?: { embedding?: unknown }[] }
  const data = body.data
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new AgenthubError('agenthub/_shared/EmbeddingUnexpectedShape', 'embedding 响应条数与输入不一致')
  }
  // 未显式配置维度时以首条为基准，保证同批向量长度一致（避免写库一半成功一半失败）。
  let expected: number | undefined = config.embeddingDim
  return data.map((item) => {
    const embedding = item.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new AgenthubError('agenthub/_shared/EmbeddingUnexpectedShape', 'embedding 响应缺少向量')
    }
    expected ??= embedding.length
    if (embedding.length !== expected) {
      throw new AgenthubError(
        'agenthub/_shared/EmbeddingUnexpectedShape',
        `embedding 维度必须为 ${expected}（实际 ${embedding.length}）`,
      )
    }
    return embedding as number[]
  })
}

async function completeJson(config: LlmConfig, fetchImpl: typeof fetch, system: string, user: string): Promise<unknown> {
  const res = await fetchImpl(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw upstreamError('chat/completions', res.status)
  const body = await res.json() as { choices?: { message?: { content?: unknown } }[] }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new AgenthubError('agenthub/_shared/LlmUnexpectedShape', '补全响应缺少 choices[0].message.content')
  }
  try {
    // 返回类型即 unknown：不加断言，`as unknown` 是多余且被 verify-no-unknown-casts 禁止的。
    return JSON.parse(content)
  } catch (error) {
    throw new AgenthubError('agenthub/_shared/LlmUnexpectedShape', '补全返回的不是合法 JSON', { cause: error })
  }
}

/** 构造客户端（阶段 B/C 调用；测试注入 fetchImpl 替身）。 */
export function createLlmClient(config: LlmConfig, fetchImpl: typeof fetch = fetch): LlmClient {
  return {
    embedTexts: texts => embedTexts(config, fetchImpl, texts),
    completeJson: (system, user) => completeJson(config, fetchImpl, system, user),
  }
}
