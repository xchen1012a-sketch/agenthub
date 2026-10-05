/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P4 方案书阶段 A T3 + 阶段 B T4/T5）。
 *
 * 装配内容：
 * 1. provide `agenthub/project-memory`（读写原语：候选 / 确认 / 检索 / 锁定 / 删除）；
 * 2. 注入器：装配期注册 `systemPrompt.context()`，按会话解析 Project 归属后把
 *    锁定项 + Top-K 注入为独立命名段落；`turn/end` 作废该会话缓存，使下一条用户
 *    消息的组装按新查询重算；
 * 3. 提取器：`session/disposed` 时读会话正文 → LLM 提候选 → 落库 → emit
 *    `agenthub/memory.candidate`（`extraction` 开启时才接）。
 *
 * 依赖处理：`agenthub/db` 与 `workspaceRegistry` 是硬前置（没有库就没有记忆、解析不出归属
 * 就无法隔离）；`systemPrompt` 与 `sessionQuery` 在「只提供读写原语 + 注入」时属**可选服务**
 * （按 packages/AGENTS.md 用 `ctx.get` 读取，缺失即降级：前者不注册注入、后者退化为只注入
 * 锁定项）；`extraction` 开启时 `sessionQuery` 转为**硬依赖**，用声明式 `inject` 等待其就位
 * （ARCH-6），而不是在装配期 `ctx.get` 自检——那能否拿到取决于注册顺序，顺序不对就会在启动
 * 期误报失败、或在真用时才发现缺服务。
 *
 * @module @agenthub/project-memory/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  AGENTHUB_EVENTS,
  createLlmClient,
  createLogger,
  readLlmConfig,
  validateLlmConfig,
  type Queryable,
} from '@agenthub/_shared'
import { LlmCandidateGenerator } from './candidate-generator.ts'
import { MemoryExtractor } from './memory-extractor.ts'
import { DEFAULT_TOP_K, MemoryInjector } from './memory-injector.ts'
import { resolveProjectId } from './project-resolver.ts'
import { ProjectMemoryService } from './service.ts'

export const name = '@agenthub/project-memory' as const

/** 插件配置（agenthub.yaml `agenthub.projectMemory` 段）。 */
export interface Config {
  /** 是否启用会话结束后的候选提取（关闭则本插件只提供读写原语与注入）。 */
  readonly extraction: boolean
  /** 非锁定项注入条数上限；`projects.memory_policy.topK` 可覆盖。 */
  readonly topK: number
  /** 单次提取最多落库的候选条数。 */
  readonly extractMaxCandidates: number
}

export const Config = z.object({
  // 缺省关闭：提取需要真实 LLM + embedding 端点，未配置的环境不应因此起不来（D30）。
  extraction: z.boolean().default(false),
  topK: z.number().default(DEFAULT_TOP_K),
  extractMaxCandidates: z.number().default(5),
})

/** 硬依赖：共享 DB 连接（`@agenthub/auth` provide `agenthub/db`）+ 上游 Workspace 注册表
 * （D34：会话 `cwd` → Workspace 必须走上游 `resolveByPath`，不能拿目录名当 projectId）。 */
export const inject = ['agenthub/db', 'workspaceRegistry'] as const

/** 可选服务读取（`ctx.get` 是全局服务读取，不随拓扑变化，见 packages/AGENTS.md）。 */
function sessionQueryOf(ctx: Context): SessionQueryEngine | undefined {
  return ctx.get('sessionQuery')
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['agenthub/db', 'workspaceRegistry'], (injected) => {
    const logger = createLogger('agenthub/project-memory')
    const db = injected.get('agenthub/db') as Queryable
    const registry = injected.get('workspaceRegistry') as WorkspaceRegistry
    const service = new ProjectMemoryService(db, { logger })

    // 注入器：装配期注册同步 provider；事件读取按需解析 sessionQuery（其服务可能在
    // 本插件之后挂载，故不在装配期取）。
    const llm = createLlmClient(readLlmConfig(process.env))
    const injector = new MemoryInjector(db, registry, service, llm, {
      logger,
      topK: config.topK,
      readEvents: async (sessionId) => {
        const sessionQuery = sessionQueryOf(ctx)
        if (sessionQuery === undefined) return []
        const snapshot = await sessionQuery.readSession(sessionId as never)
        return snapshot.events
      },
    })
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt === undefined) {
      logger.warn(
        { event: 'plugin.injector-unavailable', projectId: null, userId: null, traceId: null, sessionId: null },
        { reason: 'systemPrompt service missing' },
      )
    } else {
      systemPrompt.context(injector.promptContext())
    }

    // turn 结束即作废该会话的注入缓存：provider 在组装期只读缓存，重算由下一次组装触发，
    // 因此这里不能省——否则查询向量会一直停在上一条用户消息上。
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      injector.invalidateSession(String(session.id))
    })

    if (config.extraction) {
      // 提取依赖真实对话与向量化端点：配置缺失必须在启动期暴露，
      // 不得等到某次会话结束才以"提取失败"的告警形式出现（ARCH-7）。
      validateLlmConfig(process.env)
      // sessionQuery 在此模式下是硬依赖：声明式等待而非装配期自检（ARCH-6）。
      injected.inject(['sessionQuery'], (queryScope) => {
        const sessionQuery = queryScope.get('sessionQuery') as SessionQueryEngine
        const extractor = new MemoryExtractor(
          service,
          new LlmCandidateGenerator(llm, { logger, maxCandidates: config.extractMaxCandidates }),
          { logger, maxCandidates: config.extractMaxCandidates },
        )
        ctx.on('session/disposed', (session: Session) => {
          // 上游对 disposed 监听器做 promise catch 兜底（只记日志）；这里再收敛一层：
          // 提取是增强能力，任何失败都不得冒泡到会话销毁路径。
          void extractDisposedSession({ ctx, sessionQuery, extractor, injector, logger }, session, db, registry)
        })
        logger.info(
          { event: 'plugin.extraction-enabled', projectId: null, userId: null, traceId: null, sessionId: null },
          { maxCandidates: config.extractMaxCandidates },
        )
      })
    }

    ctx.provide('agenthub/project-memory', service)
    logger.info({ event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null }, {})
  })
}

interface ExtractDeps {
  ctx: Context
  sessionQuery: SessionQueryEngine
  extractor: MemoryExtractor
  injector: MemoryInjector
  logger: ReturnType<typeof createLogger>
}

/** 会话结束时提取候选；任何失败只告警（不阻断销毁）。 */
async function extractDisposedSession(
  deps: ExtractDeps,
  session: Session,
  db: Queryable,
  registry: WorkspaceRegistry,
): Promise<void> {
  const { ctx, sessionQuery, extractor, injector, logger } = deps
  const sessionId = String(session.id)
  try {
    // 归属解析先于读取：解析不出 Project 就不必读会话、也不必调 LLM（fail-closed）。
    const project = await resolveProjectId(db, registry, session.header.cwd)
    if (project === null) {
      logger.debug(
        { event: 'memory.extract-skipped', projectId: null, userId: null, traceId: null, sessionId },
        { reason: 'project-unresolved', cwd: session.header.cwd ?? null },
      )
      return
    }
    const snapshot = await sessionQuery.readSession(session.id)
    const stored = await extractor.extract({ projectId: project.projectId, sessionId, events: snapshot.events })
    if (stored.length === 0) return
    injector.invalidate()
    ctx.emit(AGENTHUB_EVENTS.memoryCandidate, { projectId: project.projectId, sessionId, count: stored.length })
    logger.info(
      { event: 'memory.candidates-stored', projectId: project.projectId, userId: null, traceId: null, sessionId },
      { count: stored.length },
    )
  } catch (error) {
    logger.warn(
      { event: 'memory.extract-failed', projectId: null, userId: null, traceId: null, sessionId },
      { reason: error instanceof Error ? error.message : String(error) },
    )
  }
}
