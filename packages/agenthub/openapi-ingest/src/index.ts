/**
 * @agenthub/openapi-ingest —— OpenAPI / MCP / 手工 → Tool 草稿（P3 方案书阶段 C T5）。
 *
 * P3 范围：OpenAPI 3.x `paths` → operation 级草稿行（`tools`，`enabled=false`）；
 * `$ref` 就地展开；不支持特性报错跳过并回执。
 * P4 阶段 C3-A：可选 LLM 风险分级（`classifyRisk` 端口；未注入即关闭）。
 *
 * @module @agenthub/openapi-ingest
 */
export {
  OpenApiIngestService,
  DUPLICATE_REASON,
  RISK_FAILED_REASON,
  RISK_INVALID_REASON,
  isRiskLevel,
  type IngestProgressReporter,
  type OpenApiIngestOptions,
  type RiskClassificationInput,
  type RiskClassifier,
  type RiskLevel,
} from './service.ts'
export { ScanRegistry, type ScanListener, type ScanPhase, type ScanProgress } from './progress.ts'
export { createLlmRiskClassifier } from './risk-classifier.ts'
export {
  HTTP_METHODS,
  SKIP_REASONS,
  isSafePath,
  normalizeToolName,
  parseOpenApiDocument,
  type ParsedDocument,
} from './parser.ts'
export type { IngestOptions, IngestReceipt, SkippedOperation, ToolDraft } from './types.ts'
export { name, inject, apply } from './plugin.ts'
