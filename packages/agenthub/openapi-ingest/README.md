# @agenthub/openapi-ingest

OpenAPI 导入器（P3 方案书阶段 C T5）：OpenAPI 3.x `paths` → operation 级 Tool 草稿行。

## 行为

- **解析**（`parseOpenApiDocument`，纯函数无 IO）：扫描 `paths` 的 7 个 HTTP method → 每个 operation 产出一行草稿；参数与请求体汇成 `parameters = { type:'object', properties, required? }`（0007 `tools.parameters` JSONB）。`$ref` **就地展开**（仅本地 `#/...` JSON Pointer，支持 `~0`/`~1` 转义与 OpenAPI 3.1 兄弟键覆盖）。
- **报错跳过**（不阻断整段导入，原因随回执返回）：`missing_operation_id` / `unsupported_external_ref` / `unresolved_ref` / `unsupported_circular_ref` / `unsupported_parameter`（缺 `schema`）/ `unsupported_request_body`（非 `application/json`）。非 3.x / 非对象 / 缺 `paths` 属**整段失败**，抛 `AgenthubError(422)`。
- **落库**（`OpenApiIngestService`）：`ingestFromJson(json, options)` 逐草稿 `INSERT INTO tools`，`source='openapi'`、`risk_level='read'`、`enabled=false`；`name`（`operationId`）唯一约束冲突经 `ON CONFLICT (name) DO NOTHING` 跳过并计入 `skipped`（`duplicate_operation_id`），不静默吞掉。`ingestFromUrl(systemConnectionId)` 先取文档（`openapi_url` 优先 → 缓存 `openapi_doc` → 422 `MissingOpenApiSource`）。
- **无 LLM 风险分级**（P4）：草稿一律 `risk_level='read'`，由管理台 / 后续阶段再调。

## 服务名

`agenthub/openapi-ingest`（`OpenApiIngestService`）。只依赖 `agenthub/db`：直读 `system_connections`、直写 `tools`。Tool 的注册与执行由 `@agenthub/system-connector` 负责（`tools.source_ref` 约定为 `"<METHOD> <path>"`，两包共用）。

## 边界

- 不回写 `tools.enabled`；启用与 Project 可见性由 `@agenthub/project-tool-scope` / 管理台决定。
- MCP / 手工导入属后续增强，P3 仅落地 OpenAPI 路径。