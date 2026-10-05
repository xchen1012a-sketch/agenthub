/**
 * LLM 候选生成器（P4 方案书阶段 B T4）。
 *
 * 把会话正文交给对话模型挑出值得跨会话复用的项目事实，再用 embedding 客户端把
 * 通过校验的候选项向量化。两处外部调用都走 `@agenthub/_shared` 的 `LlmClient`
 * （对话走 DeepSeek 兼容端点，向量化走 OpenAI 兼容端点，见 D20）。
 *
 * 解析是 fail-closed 的：模型返回非 JSON 数组、空串、超长串、或条数不足以覆盖
 * 要求时，只丢掉不合规的条目；**一条都不合规就不返回任何候选**——宁可不记，
 * 也不把模型跑偏的输出写成项目记忆。
 *
 * 脱敏（BND-1）：正文与候选项都是「发给模型的文本」，**外发前**必须先过 `redactText`。
 * 服务层落库前的那道脱敏发生在请求之后，拦不住已经送出去的请求体，不能当作唯一防线。
 *
 * @module @agenthub/project-memory/candidate-generator
 */
import { AgenthubError, createLogger, redactText, type LlmClient, type Logger } from '@agenthub/_shared'
import type { StoreCandidateInput } from './service.ts'
import type { CandidateGenerator, ExtractCandidatesRequest } from './memory-extractor.ts'

/** 单条候选的字符上限：超过即视为模型没有收敛，丢弃该条。 */
export const CANDIDATE_CONTENT_MAX_CHARS = 1_000

/** 提取用系统提示（要求严格 JSON，便于结构化解析）。 */
export const EXTRACTION_SYSTEM_PROMPT = [
  '你是一个项目记忆提取器。你会读到一段人与 AI 助手的历史对话。',
  '你的任务：找出其中**值得跨会话长期复用**的项目事实，例如：项目约定、技术选型、口径定义、',
  '流程规范、明确的偏好与禁忌、已确认的结论。',
  '不要提取：寒暄、临时调试过程、一次性问答、助手自己的解释性文字、任何密码/令牌/密钥内容。',
  '只输出 JSON，格式为 {"memories": ["条目1", "条目2"]}。',
  '每条用一句陈述句，独立可读，不引用"上面""刚才"这类上下文代词。',
  '没有值得记录的内容时返回 {"memories": []}。',
].join('')

export interface CandidateGeneratorOptions {
  readonly logger?: Logger
  /** 一次提取最多要求模型给出的条数（`agenthub.projectMemory.extractMaxCandidates`）。 */
  readonly maxCandidates: number
}

/** 基于 OpenAI 兼容客户端的候选生成器。 */
export class LlmCandidateGenerator implements CandidateGenerator {
  private readonly logger: Logger

  constructor(
    private readonly llm: LlmClient,
    private readonly options: CandidateGeneratorOptions,
  ) {
    this.logger = options.logger ?? createLogger('agenthub/project-memory')
  }

  /**
   * 生成候选：对话模型挑事实 → 向量化。
   * @param request - 会话正文（`transcript`）与归属信息。
   * @returns 可直接落库的候选；模型无有效输出时返回空数组。
   * @throws AgenthubError `agenthub/project-memory/CandidateShapeInvalid` 模型返回不是 JSON 对象；
   * 向量化失败原样抛 `agenthub/_shared/LlmUpstreamError`。
   */
  async generate(request: ExtractCandidatesRequest): Promise<StoreCandidateInput[]> {
    const transcript = request.transcript ?? ''
    if (transcript.trim() === '') return []
    // 外发前先打码：会话正文里可能夹带用户在对话中贴过的 token / 口令（BND-1）。
    const safeTranscript = redactText(transcript)
    const payload = await this.llm.completeJson(
      EXTRACTION_SYSTEM_PROMPT,
      buildUserPrompt(request, safeTranscript, this.options.maxCandidates),
    )
    const contents = readMemories(payload)
    if (contents.length === 0) {
      this.logger.debug(
        { event: 'memory.no-candidate', projectId: request.projectId, userId: null, traceId: null, sessionId: request.sessionId },
        {},
      )
      return []
    }
    // 候选项同样要外发（向量化）：先打码再算，向量的输入与落库内容才是同一份文本。
    const safeContents = contents.map(redactText)
    const embeddings = await this.llm.embedTexts(safeContents)
    return safeContents.map((content, index) => ({
      projectId: request.projectId,
      content,
      embedding: embeddings[index] ?? [],
      createdBySessionId: request.sessionId,
    }))
  }
}

/** 用户消息：正文 + 条数要求（模型看到的是纯文本，无凭据）。 */
function buildUserPrompt(request: ExtractCandidatesRequest, transcript: string, maxCandidates: number): string {
  return [
    `会话 id：${request.sessionId}`,
    `最多输出 ${maxCandidates} 条。`,
    '以下是对话正文：',
    '---',
    transcript,
    '---',
  ].join('\n')
}

/**
 * 解析并过滤模型输出。
 * @param payload - `completeJson` 的返回值（未知形状）。
 * @returns 去空、去重、限长后的候选项；不合规条目被丢弃。
 * @throws AgenthubError 顶层不是含 `memories` 数组的对象。
 */
export function readMemories(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new AgenthubError('agenthub/project-memory/CandidateShapeInvalid', '提取结果不是 JSON 对象')
  }
  const raw = (payload as { memories?: unknown }).memories
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new AgenthubError('agenthub/project-memory/CandidateShapeInvalid', '提取结果 memories 不是数组')
  }
  const seen = new Set<string>()
  const contents: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const content = item.trim()
    if (content === '' || content.length > CANDIDATE_CONTENT_MAX_CHARS) continue
    if (seen.has(content)) continue
    seen.add(content)
    contents.push(content)
  }
  return contents
}
