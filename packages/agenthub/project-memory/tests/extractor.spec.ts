/**
 * 会话文本提取与候选生成（P4 阶段 B T4）。
 *
 * 覆盖：上游 `extractSessionEventText` 语义面过滤、字节上限截断（含多字节字符）、
 * LLM 输出解析的 fail-closed 行为、向量化调用次数。
 *
 * @module tests/extractor.spec
 */
import { describe, expect, it, vi } from 'vitest'
import { AgenthubError, type LlmClient } from '@agenthub/_shared'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { extractSessionText, lastUserMessageText } from '../src/extraction.ts'
import { LlmCandidateGenerator, readMemories, CANDIDATE_CONTENT_MAX_CHARS } from '../src/candidate-generator.ts'

/** 最小事件形状：只提供 extractSessionEventText 关心的字段。 */
function userMessage(text: string): SessionEvent {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text }] },
  } as unknown as SessionEvent
}

function assistantMessage(text: string): SessionEvent {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  } as unknown as SessionEvent
}

function stepStart(): SessionEvent {
  // 上游 `SessionEvent` 除 type/data 外还带 seq 等字段，测试只需"一条非正文事件"，
  // 故与本文件其他事件替身一致地用断言（见 userMessage / assistantMessage）。
  return { type: 'step/start', data: { turn: 1, step: 1 } } as unknown as SessionEvent
}

/** 只实现被测方法的 LLM 替身。 */
function fakeLlm(overrides: Partial<LlmClient> = {}): LlmClient {
  return {
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    completeJson: vi.fn(async () => ({ memories: [] })),
    ...overrides,
  }
}

describe('extractSessionText', () => {
  it('拼接用户与助手消息、跳过无语义事件', () => {
    const text = extractSessionText([stepStart(), userMessage('用 PostgreSQL'), stepStart(), assistantMessage('好的')])
    expect(text).toBe('用 PostgreSQL\n好的')
  })

  it('无可用文本返回空串', () => {
    expect(extractSessionText([stepStart()])).toBe('')
    expect(extractSessionText([])).toBe('')
  })

  it('超上限时保留尾部并标注省略', () => {
    const long = 'x'.repeat(500)
    const text = extractSessionText([userMessage(long), userMessage('END')], 120)
    expect(text).toContain('更早的对话已省略')
    expect(text.endsWith('END')).toBe(true)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(121)
  })

  it('多字节字符截断不产生半个字符（不出现 U+FFFD）', () => {
    // 每个「项目记忆」12 字节；预算 96 字节（扣除省略标记后约 58 字节）必然落在字符中间。
    const text = extractSessionText([userMessage('项目记忆'.repeat(200))], 96)
    expect(text).toContain('更早的对话已省略')
    expect(text).not.toContain('\uFFFD')
    expect(text).toContain('项目记忆')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(97)
  })
})

describe('lastUserMessageText', () => {
  it('取最后一条用户消息', () => {
    expect(lastUserMessageText([userMessage('第一问'), assistantMessage('答'), userMessage('第二问')])).toBe('第二问')
  })

  it('没有用户消息返回 null', () => {
    expect(lastUserMessageText([stepStart(), assistantMessage('答')])).toBeNull()
  })
})

describe('readMemories', () => {
  it('去空、去重、丢弃非字符串与超长条目', () => {
    const contents = readMemories({
      memories: ['  保留  ', '', '保留', 42, null, 'y'.repeat(CANDIDATE_CONTENT_MAX_CHARS + 1), '另一条'],
    })
    expect(contents).toEqual(['保留', '另一条'])
  })

  it('memories 缺失视为无候选', () => {
    expect(readMemories({})).toEqual([])
  })

  it('顶层不是对象 / memories 不是数组 → 抛 CandidateShapeInvalid', () => {
    expect(() => readMemories('nope')).toThrow(AgenthubError)
    expect(() => readMemories({ memories: 'nope' })).toThrow(/不是数组/)
    try {
      readMemories('nope')
    } catch (error) {
      expect((error as AgenthubError).code).toBe('agenthub/project-memory/CandidateShapeInvalid')
    }
  })
})

describe('LlmCandidateGenerator', () => {
  const request = {
    projectId: 'p-1',
    sessionId: 's-1',
    events: [] as readonly SessionEvent[],
    transcript: '用户：我们统一用 PostgreSQL',
  }

  it('LLM 返回候选 → 一次 embedTexts 批量向量化，逐条带归属与来源会话', async () => {
    const embedTexts = vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3]))
    const llm = fakeLlm({ embedTexts, completeJson: vi.fn(async () => ({ memories: ['A', 'B'] })) })
    const generator = new LlmCandidateGenerator(llm, { maxCandidates: 5 })

    const candidates = await generator.generate(request)
    expect(candidates.map(item => item.content)).toEqual(['A', 'B'])
    expect(candidates.every(item => item.projectId === 'p-1')).toBe(true)
    expect(candidates.every(item => item.createdBySessionId === 's-1')).toBe(true)
    expect(embedTexts).toHaveBeenCalledTimes(1)
    expect(embedTexts).toHaveBeenCalledWith(['A', 'B'])
  })

  it('模型无有效候选时不调用向量化', async () => {
    const embedTexts = vi.fn(async (texts: string[]) => texts.map(() => [0]))
    const llm = fakeLlm({ embedTexts, completeJson: vi.fn(async () => ({ memories: [] })) })
    const generator = new LlmCandidateGenerator(llm, { maxCandidates: 5 })

    await expect(generator.generate(request)).resolves.toEqual([])
    expect(embedTexts).not.toHaveBeenCalled()
  })

  it('空正文不发请求（不浪费一次 LLM 调用）', async () => {
    const completeJson = vi.fn(async () => ({ memories: ['A'] }))
    const generator = new LlmCandidateGenerator(fakeLlm({ completeJson }), { maxCandidates: 5 })

    await expect(generator.generate({ ...request, transcript: '   ' })).resolves.toEqual([])
    expect(completeJson).not.toHaveBeenCalled()
  })

  it('BND-1：正文与候选项都在外发前打码（请求体不含凭证明文）', async () => {
    let sentUser = ''
    const completeJson = vi.fn(async (_system: string, user: string) => {
      sentUser = user
      return { memories: ['部署口令 password: hunter2'] }
    })
    const embedTexts = vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3]))
    const generator = new LlmCandidateGenerator(fakeLlm({ completeJson, embedTexts }), { maxCandidates: 5 })

    const candidates = await generator.generate({ ...request, transcript: '连接串 token=super-secret-123 记一下' })

    // 发给对话模型的是打码后的正文
    expect(sentUser).toContain('token=***')
    expect(sentUser).not.toContain('super-secret-123')
    // 发给向量端点的候选项同样已打码，落库内容与向量输入是同一份文本
    expect(embedTexts).toHaveBeenCalledWith(['部署口令 password=***'])
    expect(candidates[0]?.content).not.toContain('hunter2')
  })
})
