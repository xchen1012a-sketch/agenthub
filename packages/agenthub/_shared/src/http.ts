/**
 * node:http 请求/响应助手（各 @agenthub/* 包共用，plugin-skeleton §5.2 U5 envelope）。
 *
 * 职责：JSON 读写、错误 envelope 响应、重定向、traceId 解析入参。
 * 刻意不引入 HTTP 框架：上游 webServer seam 的 handler 直接持有
 * IncomingMessage / ServerResponse（dsh-host-webserver WebRoute）。
 *
 * @module @agenthub/_shared/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { toErrorEnvelope } from './errors.ts'
import { resolveTraceId } from './trace-id.ts'
import type { TraceId } from './types.ts'

/** 从请求头解析 traceId（OBS-1：合法 UUIDv4 采纳，否则生成）。 */
export function traceIdOf(req: IncomingMessage): TraceId {
  const raw = req.headers['x-trace-id']
  return resolveTraceId(Array.isArray(raw) ? raw[0] : raw)
}

/** JSON 响应（可空字段由调用方保证 null，.ai-spec 40-extension.md EXT-7）。 */
export function sendJson(res: ServerResponse, status: number, body: unknown, traceId?: string): void {
  if (traceId !== undefined) res.setHeader('x-trace-id', traceId)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** U5 错误 envelope 响应：AgenthubError 透出 code/message，其余 fail-closed。 */
export function sendError(res: ServerResponse, error: unknown, traceId: string): void {
  sendJson(res, errorStatus(error), toErrorEnvelope(error, traceId), traceId)
}

function errorStatus(error: unknown): number {
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500
}

/** 302 重定向（表单提交 → 列表/详情页）。 */
export function sendRedirect(res: ServerResponse, location: string, traceId: string): void {
  res.statusCode = 302
  res.setHeader('location', location)
  res.setHeader('x-trace-id', traceId)
  res.end()
}

/** HTML 响应。 */
export function sendHtml(res: ServerResponse, status: number, html: string, traceId: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('x-trace-id', traceId)
  res.end(html)
}

/** 请求体统一上限（1MB）：登录 / New Project 表单与 JSON 体的量级远低于此。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 读取请求体并按 JSON 解析；空体 / 非 JSON 一律返回 undefined（调用方 fail-closed）。 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((sum, item) => sum + item.length, 0) > MAX_BODY_BYTES) return undefined
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取 application/x-www-form-urlencoded 请求体（登录 / New Project 表单）。
 * 超过 1MB 上限后只消费不缓存（保护内存，同时不破坏 keep-alive 请求帧），
 * 返回空表单——调用方按"缺字段"走既有 fail-closed 校验（如 InvalidName 422）。
 */
export async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let total = 0
  let overLimit = false
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    if (overLimit) continue
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      overLimit = true
      continue
    }
    chunks.push(buffer)
  }
  if (overLimit || chunks.length === 0) return new URLSearchParams()
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
