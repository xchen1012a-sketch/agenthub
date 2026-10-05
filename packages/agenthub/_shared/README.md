# @agenthub/_shared

AgentHub 插件包共享基础设施。所有 `@agenthub/*` 包依赖本包；本包只依赖上游 `@deepseek-ai/dsh-brand`（类型层），禁止反向依赖任何业务包。

## 公开 API

| 模块 | 导出 | 规范依据 |
| --- | --- | --- |
| `trace-id` | `TRACE_ID_KEY` / `isUuidV4` / `createTraceId` / `resolveTraceId` / `getTraceId` / `TraceIdSource` | .ai-spec 40-extension.md EXT-8（OBS-1） |
| `logger` | `createLogger` / `levelFromEnv` / `jsonLineSink` / `LogInput` / `LogRecord` / `Logger` | .ai-spec 40-extension.md EXT-7（OBS-2，U3 八字段） |
| `redact` | `redact` / `redactText` / `REDACTED` | .ai-spec 40-extension.md EXT-7 / .ai-spec 20-security.md SEC-1（V5） |
| `errors` | `AgenthubError` / `isAgenthubError` / `toErrorEnvelope` / `ErrorEnvelope` | .ai-spec 40-extension.md EXT-9（U5） |
| `events` | `AGENTHUB_EVENTS` / 八事件 Payload 接口 / `AgenthubEventPayloads` | .ai-spec 40-extension.md EXT-5+EXT-6 |
| `types` | `ProjectId` / `UserId` / `SessionId` / `WorkspaceId` / `TraceId` 及 `as*` 助手 | .ai-spec 00-boundaries.md BND-4 |

## 依赖方向

```
@agenthub/auth|rbac|project|... ──▶ @agenthub/_shared ──▶ @deepseek-ai/dsh-brand（仅类型）
```
