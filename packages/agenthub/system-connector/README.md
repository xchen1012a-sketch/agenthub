# @agenthub/system-connector

外部系统连接器（P3 方案书阶段 C T6）：`system_connections` CRUD + connector Tool 执行体 + session 反代授权捕获。

## 行为

- **CRUD**：0004 `system_connections` 表首次接服务。`createConnection` / `listConnections` / `getConnection` / `updateConnection` / `deleteConnection`；读取显式列名（禁 `SELECT *`），`base_url` 归一化到 `origin`，`auth_mode` 限 0004+0013 六值域（含 D14 的 `session`）。
- **connector Tool 执行体**（`ConnectorToolRegistry`）：对 `tools.enabled = true` 且 `source = 'openapi'` 且挂着 `system_connection` 的行注册真实 Tool。执行体内 `vault.resolveToken` → 按 `auth_mode` 注入 `cookie`（session）/ `authorization`（其余）→ fetch 外部系统。`tools.source_ref` 约定为 `"<METHOD> <path>"`（openapi-ingest 写入），GET 入参进 query，其余进 JSON body。
- **阻断分支**（D16）：未绑定 → `external-system.token-required` + `denied:credential_missing`；过期 → `denied:credential_expired`（`credential.expired` 由 vault 发出）；上游 403 → `denied:upstream_403`；非 2xx → `UpstreamError(502)`。阻断方仅发 `agenthub/tool.denied`，audit 订阅后置 `status='denied'` 并把语义写入 `result_meta.reason`。
- **session 反代授权**（D14）：`GET /agenthub/connections/:id/authorize` → 302 到 `/agenthub/connections/:id/proxy/`；用户在反代页面登录外部系统，登录响应的 `Set-Cookie` 被捕获 → `vault.storeCredential` 加密落库。硬边界：仅已认证用户可达；仅该 connection 的 `base_url`（同源校验）；**响应不回传 `set-cookie` 给浏览器**（会话只落服务端 vault）；每次代用出 `connector.proxy` 日志（不含凭证明文）。
- **MCP 薄预留**（D12）：`attachMCP` 为接口占位 + `@deepseek-ai/dsh-mcp-client` optional peer 声明，调用即抛 `NotImplemented`（501）。

## 服务名

`agenthub/system-connector`（`SystemConnectorService`）。依赖 `agenthub/db` / `agenthub/vault` / `agenthub/auth` / `agenthub/tool-scope` / `tools`；`webServer` 为可选装配（无 web 时不注册反代路由）。

## 不可见承诺（G2）

`resolveToken` 返回值只允许注入本次外部请求，禁止进入日志 / 事件 / 审计。