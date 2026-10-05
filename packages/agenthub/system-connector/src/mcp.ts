/**
 * MCP 薄桥接预留（P3 方案书 D12）。
 *
 * P3 只做接口占位 + 依赖声明（`@deepseek-ai/dsh-mcp-client` 为 optional peer），
 * 真正的按 Project 暴露 MCP server 留后续阶段。调用即抛 NotImplemented（501），
 * 避免"看起来可用、实则未接线"的静默缺口。
 *
 * @module @agenthub/system-connector/mcp
 */
import type { Context } from '@deepseek-ai/cordis'
import { AgenthubError } from '@agenthub/_shared'

export interface AttachMcpOptions {
  readonly ctx: Context
  readonly connectionId: string
  /** 该连接声明的 MCP server 地址（0004 `mcp_servers` JSONB）。 */
  readonly servers: readonly string[]
}

/** 占位：P3 不实现 MCP 全链路（薄预留，D12）。 */
export function attachMCP(_options: AttachMcpOptions): never {
  throw new AgenthubError(
    'agenthub/system-connector/NotImplemented',
    'attachMCP 为 P3 薄预留（D12）：MCP 全链路留后续阶段，当前不启用',
    { httpStatus: 501 },
  )
}
