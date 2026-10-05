# @agenthub/health

健康检查包（阶段书 §3.1 #13）。

## 职责

- `GET /healthz`（上游 `ctx.webServer` 精确路由）：
  - DB `select 1` 成功 → 200 `{"status":"ok","version":"<AGENTHUB_VERSION>","db":"ok"}`（V1）。
  - 失败 → 503 `{"status":"degraded","db":"error"}`（fail-closed，不外泄错误细节）。
- 无身份要求（探针可达性优先，只读无副作用）。

## 公开 API

- `HealthService.check()` / `HEALTHZ_PATH`。
- Cordis：`apply(ctx)` → `ctx.webServer.register(...)`。

## 依赖方向

`@agenthub/_shared`；运行时依赖 `pg`（`AGENTHUB_DB_URL`）；上游 seam 仅 `@deepseek-ai/dsh-host-webserver` 公开 API。
