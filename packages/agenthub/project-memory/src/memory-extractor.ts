/**
 * Memory Extractor（P4 方案书阶段 B T4）。
 *
 * 一次会话结束后产候选：读会话正文 → LLM 提取 ≤N 条候选 → 逐条向量化并落
 * `metadata.status='candidate'`（不入检索区间）→ 返回落库结果供调用方 emit 事件。
 *
 * 设计约束（P4 §4.1 / §8）：
 * - **不阻断销毁**：异常一律在插件层收敛为告警日志，本模块只负责把失败如实抛出；
 * - **不猜归属**：projectId 由调用方解析好（`resolveProjectId`），解析不出就不调用本模块；
 * - **查询向量只算一次**：提取 prompt 不依赖 embedding，逐条向量化按批一次调用。
 *
 * @module @agenthub/project-memory/memory-extractor
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createLogger, type Logger } from '@agenthub/_shared'
import { extractSessionText } from './extraction.ts'
import type { ProjectMemoryService, StoreCandidateInput } from './service.ts'

/** 一次提取请求（归属与正文由调用方准备，便于单测直接构造）。 */
export interface ExtractCandidatesRequest {
  /** 候选归属的 Project，由 `resolveProjectId` 解析得到。 */
  readonly projectId: string
  /** 会话 id，写入 `metadata.created_by_session_id` 作为候选来源。 */
  readonly sessionId: string
  /** 会话原始事件（`sessionQuery.readSession().events`）。 */
  readonly events: readonly SessionEvent[]
  /**
   * 已截断的会话正文；缺省时由 {@link MemoryExtractor} 从 `events` 拼装。
   * 生成器只读这个字段，保证正文只截断一次（正文与 prompt 不会各截一次）。
   */
  readonly transcript?: string
  /** 取消信号（会话已销毁时通常已 abort，此时不再发起 LLM 调用）。 */
  readonly signal?: AbortSignal
}

/** 候选生成器（LLM 提取 + 向量化；单测注入替身，避免真实端点）。 */
export interface CandidateGenerator {
  /**
   * 生成候选（已向量化、可直接落库）。
   * 声明为属性而非方法：调用方（含测试替身）常把它作为函数值传递或断言，
   * 方法签名会触发 `unbound-method` 误报。
   */
  readonly generate: (request: ExtractCandidatesRequest) => Promise<StoreCandidateInput[]>
}

export interface MemoryExtractorOptions {
  readonly logger?: Logger
  /** 单次提取最多落库的候选条数（`agenthub.projectMemory.extractMaxCandidates`）。 */
  readonly maxCandidates: number
  /** 会话正文字节上限。 */
  readonly sessionTextMaxBytes?: number
}

export class MemoryExtractor {
  private readonly logger: Logger

  constructor(
    private readonly memories: ProjectMemoryService,
    private readonly generator: CandidateGenerator,
    private readonly options: MemoryExtractorOptions,
  ) {
    this.logger = options.logger ?? createLogger('agenthub/project-memory')
  }

  /**
   * 提取并落候选。
   * @param request - 归属、会话 id、事件序列与取消信号。
   * @returns 已落库的候选（按生成顺序，已截断到 `maxCandidates`）。
   * @throws 读取正文失败、LLM 失败、向量化失败时抛出，由调用方转告警日志。
   */
  async extract(request: ExtractCandidatesRequest): Promise<StoreCandidateInput[]> {
    const transcript = extractSessionText(request.events, this.options.sessionTextMaxBytes)
    if (transcript.trim() === '') {
      this.logger.debug(
        { event: 'memory.extract-skipped', projectId: request.projectId, userId: null, traceId: null, sessionId: request.sessionId },
        { reason: 'empty-transcript' },
      )
      return []
    }

    const generated = await this.generator.generate({ ...request, transcript, events: request.events })
    const limited = generated.slice(0, Math.max(0, this.options.maxCandidates))
    const stored: StoreCandidateInput[] = []
    for (const candidate of limited) {
      // 单条失败不丢整批：候选之间互相独立，继续落剩下的并逐条告警。
      try {
        await this.memories.storeCandidate({
          projectId: request.projectId,
          content: candidate.content,
          embedding: candidate.embedding,
          createdBySessionId: candidate.createdBySessionId ?? request.sessionId,
        })
        stored.push(candidate)
      } catch (error) {
        this.logger.warn(
          { event: 'memory.candidate-store-failed', projectId: request.projectId, userId: null, traceId: null, sessionId: request.sessionId },
          { reason: error instanceof Error ? error.message : String(error) },
        )
      }
    }
    return stored
  }
}
