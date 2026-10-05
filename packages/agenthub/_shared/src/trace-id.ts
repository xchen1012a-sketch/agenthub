/**
 * TraceId 生命周期（.ai-spec 40-extension.md EXT-8，OBS-1）。
 *
 * HTTP 中间件：`x-trace-id` 头（合法 UUIDv4 才信任）→ `ctx.provide(TRACE_ID_KEY, ...)`
 * → logger `trace_id` 字段 / audit_records.trace_id / session events metadata.traceId 同源。
 *
 * @module @agenthub/_shared/trace-id
 */
import { randomUUID } from 'node:crypto'
import { asTraceId, type TraceId } from './types.ts'

/** Cordis ctx 中 traceId 的 provide 键；@agenthub/auth 中间件负责注入。 */
export const TRACE_ID_KEY = 'agenthub/traceId'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value)
}

/** 生成新的 UUIDv4 TraceId（缺失 / 非法 header 时的兜底来源）。 */
export function createTraceId(): TraceId {
  return asTraceId(randomUUID())
}

/**
 * HTTP 中间件入口（OBS-1）：合法 UUIDv4 header 原样采纳，
 * 缺失 / 非法一律生成新 UUIDv4 —— 保证三处（header → ctx → 日志）恒有同一合法值。
 */
export function resolveTraceId(header: string | null | undefined): TraceId {
  return header !== null && header !== undefined && isUuidV4(header)
    ? asTraceId(header)
    : createTraceId()
}

/**
 * 最小结构化读取面：兼容 Cordis Context
 * （`ctx.provide(TRACE_ID_KEY, value)` 之后即可经属性访问读取）。
 */
export interface TraceIdSource {
  readonly [TRACE_ID_KEY]?: unknown
}

/**
 * 统一读取入口（.ai-spec 40-extension.md EXT-8 SHOULD 的 getTraceId(ctx) 助手）。
 * 缺失 / 非法一律返回 null —— 可空关联字段统一 null，禁止 "null" 字符串占位（§4 MUST）。
 */
export function getTraceId(source: TraceIdSource): TraceId | null {
  const value = source[TRACE_ID_KEY]
  return typeof value === 'string' && isUuidV4(value) ? asTraceId(value) : null
}
