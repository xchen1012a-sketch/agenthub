# @agenthub/audit

审计落库：订阅 `agenthub/tool.before/after-execute` 写 `audit_records`（P2 方案书 T7）。

## 行为

- **pending → 终态**：before-execute 写 `pending` 行；after-execute 回写 `status`（ok/error）与 `result_meta`（durationMs）。关联键：`(projectId, userId, sessionId, toolId)`。
- **脱敏（V5）**：args 落库前过 `_shared/redact.ts` 白名单双过滤（禁正则），`token/password/secret` 值 → `***`。
- **trace_id（OBS-3）**：注入 `getTraceId(ctx)` 透传请求级 traceId；工具执行尚不挂请求上下文时 UUIDv4 兜底。
- **fail-closed**：未在 `tools` 表登记的 Tool，risk_level 按 `critical` 记录。
- **旁路安全**：订阅回调失败只记日志，不阻断工具执行。

## 用法

```yaml
# agenthub.yaml 插件顺序：… → project-tool-scope → audit → …
```
