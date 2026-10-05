/**
 * @agenthub/project-memory —— 跨 Session 项目记忆（pgvector）。
 *
 * P4 范围：
 * - 阶段 A：核心服务（存候选 / 确认 / 拒绝 / 检索 / 锁定 / 删除）；
 * - 阶段 B：`resolveProjectId`（D32 归属解析）、`MemoryExtractor`（T4 提取）、
 *   `MemoryInjector`（T5 注入）。
 *
 * @module @agenthub/project-memory
 */
export { ProjectMemoryService } from './service.ts'
export type {
  ListMemoriesOptions,
  MemoryRecord,
  MemoryScope,
  ProjectMemoryOptions,
  StoreCandidateInput,
} from './service.ts'
export {
  resolveProjectByWorkspaceId,
  resolveProjectId,
} from './project-resolver.ts'
export type { ResolvedProject } from './project-resolver.ts'
export {
  DEFAULT_SESSION_TEXT_MAX_BYTES,
  extractSessionText,
  lastUserMessageText,
} from './extraction.ts'
export { MemoryExtractor } from './memory-extractor.ts'
export type {
  CandidateGenerator,
  ExtractCandidatesRequest,
  MemoryExtractorOptions,
} from './memory-extractor.ts'
export {
  CANDIDATE_CONTENT_MAX_CHARS,
  EXTRACTION_SYSTEM_PROMPT,
  LlmCandidateGenerator,
  readMemories,
} from './candidate-generator.ts'
export type { CandidateGeneratorOptions } from './candidate-generator.ts'
export {
  DEFAULT_TOP_K,
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  MemoryInjector,
  mergeMemories,
  renderMemoryContext,
} from './memory-injector.ts'
export type { MemoryInjectorOptions, SessionEventReader } from './memory-injector.ts'
export { name, inject, apply, Config } from './plugin.ts'
export type { Config as ProjectMemoryConfig } from './plugin.ts'
