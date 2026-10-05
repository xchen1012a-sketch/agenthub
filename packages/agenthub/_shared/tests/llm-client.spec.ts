/**
 * OpenAI 兼容 LLM / Embedding 客户端（P4 方案书阶段 A T2）。
 *
 * @module tests/llm-client.spec
 */
import { describe, expect, it } from 'vitest'
import {
  AgenthubError,
  EMBEDDING_API_KEY_VAR,
  EMBEDDING_DIM,
  LLM_API_KEY_VAR,
  LLM_BASE_URL_VAR,
  createLlmClient,
  readLlmConfig,
  validateLlmConfig,
  type EnvLike,
  type LlmConfig,
} from '@agenthub/_shared'

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    llmBaseUrl: 'https://api.deepseek.com/v1',
    llmModel: 'deepseek-chat',
    llmApiKey: 'llm-key',
    embeddingBaseUrl: 'https://api.openai.com/v1',
    embeddingModel: 'text-embedding-3-small',
    embeddingApiKey: 'embed-key',
    // 缺省不发送 dimensions（D35：部分端点不支持该字段）
    embeddingDim: undefined,
    ...overrides,
  }
}

interface CapturedRequest {
  url: string
  body: string
  headers: Record<string, string>
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function fakeFetch(handler: (req: CapturedRequest) => Response): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const fetchImpl = (async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const req: CapturedRequest = {
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : '',
      headers: init?.headers ?? {},
    }
    requests.push(req)
    return handler(req)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

function only<T>(items: T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error('expected a captured request')
  return item
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error)
}

const VECTOR = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001)

describe('readLlmConfig', () => {
  it('缺省落入默认端点/模型（对话 DeepSeek，向量化火山方舟 veCot），embedding key 回落到 LLM key', () => {
    const cfg = readLlmConfig({ [LLM_API_KEY_VAR]: 'llm-only' })
    expect(cfg.llmBaseUrl).toBe('https://api.deepseek.com/v1')
    expect(cfg.llmModel).toBe('deepseek-chat')
    expect(cfg.embeddingBaseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3')
    expect(cfg.embeddingModel).toBe('doubao-embedding-vision')
    expect(cfg.embeddingApiKey).toBe('llm-only')
    // 默认不声明维度：由端点决定（该端点不支持 dimensions 参数，D35）
    expect(cfg.embeddingDim).toBeUndefined()
  })

  it('显式覆盖 endpoint / key / 维度 生效', () => {
    const cfg = readLlmConfig({
      [LLM_BASE_URL_VAR]: 'https://llm.internal/v1',
      [EMBEDDING_API_KEY_VAR]: 'embed-only',
      [LLM_API_KEY_VAR]: 'llm-key',
      AGENTHUB_EMBEDDING_DIM: '2048',
    })
    expect(cfg.llmBaseUrl).toBe('https://llm.internal/v1')
    expect(cfg.embeddingApiKey).toBe('embed-only')
    expect(cfg.embeddingDim).toBe(2048)
  })

  it('维度非法（非正整数）抛错', () => {
    expect(() => readLlmConfig({ AGENTHUB_EMBEDDING_DIM: 'abc' })).toThrow(AgenthubError)
  })
})

describe('createLlmClient.embedTexts', () => {
  it('默认不发送 dimensions（端点自定维度），返回等长向量', async () => {
    const { fetchImpl, requests } = fakeFetch(() => jsonResponse(200, {
      data: [{ embedding: VECTOR }],
    }))
    const client = createLlmClient(config(), fetchImpl)
    const result = await client.embedTexts(['hello'])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(VECTOR)
    const req = only(requests)
    expect(req.url).toBe('https://api.openai.com/v1/embeddings')
    expect(req.headers.authorization).toBe('Bearer embed-key')
    const body = JSON.parse(req.body) as { model: string; dimensions?: number; input: string[] }
    expect(body.model).toBe('text-embedding-3-small')
    expect(body).not.toHaveProperty('dimensions')
    expect(body.input).toEqual(['hello'])
  })

  it('显式配置维度时发送 dimensions', async () => {
    const { fetchImpl, requests } = fakeFetch(() => jsonResponse(200, {
      data: [{ embedding: Array.from({ length: 2048 }, () => 0.5) }],
    }))
    const client = createLlmClient(config({ embeddingDim: EMBEDDING_DIM }), fetchImpl)
    await client.embedTexts(['hello'])
    const body = JSON.parse(only(requests).body) as { dimensions?: number }
    expect(body.dimensions).toBe(EMBEDDING_DIM)
  })

  it('返回条数与输入不一致 → EmbeddingUnexpectedShape', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { data: [] }))
    const client = createLlmClient(config(), fetchImpl)
    const error = await catchError(client.embedTexts(['a', 'b']))
    expect((error as AgenthubError).code).toBe('agenthub/_shared/EmbeddingUnexpectedShape')
  })

  it('显式维度与响应不符 → EmbeddingUnexpectedShape', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { data: [{ embedding: [0.1, 0.2] }] }))
    const client = createLlmClient(config({ embeddingDim: EMBEDDING_DIM }), fetchImpl)
    const error = await catchError(client.embedTexts(['a']))
    expect((error as AgenthubError).code).toBe('agenthub/_shared/EmbeddingUnexpectedShape')
    expect((error as Error).message).toContain(String(EMBEDDING_DIM))
  })

  it('未配置维度时同批向量长度不一致 → EmbeddingUnexpectedShape', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, {
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.1, 0.2, 0.3] }],
    }))
    const client = createLlmClient(config(), fetchImpl)
    const error = await catchError(client.embedTexts(['a', 'b']))
    expect((error as AgenthubError).code).toBe('agenthub/_shared/EmbeddingUnexpectedShape')
  })

  it('非 2xx → LlmUpstreamError(502)，消息不含密钥', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(500, { error: 'upstream' }))
    const client = createLlmClient(config(), fetchImpl)
    const error = await catchError(client.embedTexts(['a']))
    expect((error as AgenthubError).code).toBe('agenthub/_shared/LlmUpstreamError')
    expect((error as AgenthubError).httpStatus).toBe(502)
    expect((error as Error).message).not.toContain('embed-key')
  })
})

describe('createLlmClient.completeJson', () => {
  it('POST /chat/completions 带 response_format=json_object，解析 JSON 返回', async () => {
    const { fetchImpl, requests } = fakeFetch(() => jsonResponse(200, {
      choices: [{ message: { content: '{"riskLevel":"write"}' } }],
    }))
    const client = createLlmClient(config(), fetchImpl)
    await expect(client.completeJson('sys', 'user')).resolves.toEqual({ riskLevel: 'write' })
    const body = JSON.parse(only(requests).body) as { response_format: { type: string } }
    expect(body.response_format.type).toBe('json_object')
  })

  it('content 非合法 JSON → LlmUnexpectedShape', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: 'not-json' } }] }))
    const client = createLlmClient(config(), fetchImpl)
    const error = await catchError(client.completeJson('sys', 'user'))
    expect((error as AgenthubError).code).toBe('agenthub/_shared/LlmUnexpectedShape')
  })
})

describe('validateLlmConfig', () => {
  function valid(): EnvLike {
    return {
      [LLM_API_KEY_VAR]: 'llm-key',
      [EMBEDDING_API_KEY_VAR]: 'embed-key',
    }
  }

  it('合法配置不抛错', () => {
    expect(() => {
      validateLlmConfig(valid())
    }).not.toThrow()
  })

  it('缺 LLM key 抛错', () => {
    const env: EnvLike = { [EMBEDDING_API_KEY_VAR]: 'embed-key' }
    expect(() => {
      validateLlmConfig(env)
    }).toThrow(AgenthubError)
  })

  it('base url 非法 → 抛错', () => {
    const env: EnvLike = { ...valid(), AGENTHUB_LLM_BASE_URL: 'not-a-url' }
    expect(() => {
      validateLlmConfig(env)
    }).toThrow(AgenthubError)
  })

  it('embedding 维度显式设置且不等于 2048 → 抛错', () => {
    const env: EnvLike = { ...valid(), AGENTHUB_EMBEDDING_DIM: '768' }
    expect(() => {
      validateLlmConfig(env)
    }).toThrow(AgenthubError)
  })

  it('维度留空（端点自定维度）不抛错', () => {
    expect(() => {
      validateLlmConfig(valid())
    }).not.toThrow()
  })
})
