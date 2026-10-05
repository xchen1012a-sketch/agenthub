/**
 * 纯类型与导入契约（无逻辑）。
 *
 * @module @agenthub/openapi-ingest/types
 */

/** 解析出的 Tool 草稿（尚未落库；落库后 `name` 即 `tools.name`）。 */
export interface ToolDraft {
  /** `operationId`（0007 `tools.name` 唯一约束）。 */
  readonly name: string
  readonly description: string
  /** `{ type:'object', properties, required? }`（0007 `tools.parameters` JSONB）。 */
  readonly parameters: Record<string, unknown>
  /** `"<METHOD> <path>"`（system-connector 执行体据此还原 HTTP 调用）。 */
  readonly sourceRef: string
  readonly method: string
  readonly path: string
}

/** 被跳过的 operation（不支持的特性 / 缺失 operationId / 冲突），随回执返回。 */
export interface SkippedOperation {
  /** 缺失 operationId 时为 null。 */
  readonly name: string | null
  /** `"<METHOD> <path>"`；路径级失败时为 null。 */
  readonly sourceRef: string | null
  /** 机器可读原因（见 `parser.ts` 的 Reason 闭集）。 */
  readonly reason: string
}

/** 一次导入的回执（预期标准 2：冲突跳过并回执）。 */
export interface IngestReceipt {
  /** 实际写入的 `tools.name`（已落库，`enabled=false`）。 */
  readonly created: string[]
  /** 解析级 + 落库级（operationId 冲突）跳过项。 */
  readonly skipped: SkippedOperation[]
  /** 文档中遇到的 operation 总数（含跳过）。 */
  readonly total: number
}

/** 导入落库参数（`createdBy` 由服务端身份传入，模型不可决定）。 */
export interface IngestOptions {
  readonly systemConnectionId?: string | null
  readonly createdBy?: string | null
}
