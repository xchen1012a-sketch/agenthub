# @agenthub/auth

平台身份包（P1：dev 匿名 userId 中间件）。

## 职责

- dev 匿名身份解析：固定 `DEV_USER_ID`（`00000000-0000-4000-8000-000000000001`），角色 `platform_admin`。
- 身份中间件 `withIdentity`：每请求解析 traceId（OBS-1）→ 校验身份 → 业务 handler，异常统一 U5 envelope。
- dev 开关 `AGENTHUB_AUTH_DEV_ANON`：显式 `false` 时 fail-closed（503）。

## 非职责（P2 起）

- 真登录（Argon2id）、sessions 表、HttpOnly Cookie、CSRF（.ai-spec 20-security.md SEC-4）——P2 收尾补齐。

## 公开 API

- `DevAuthService`：`resolveUser()` / `signInDev(traceId)` / `enabled`。
- `withIdentity(auth, handler)`：上游 `WebRoute.handler` 形态的包装器。
- Cordis：`apply(ctx)` → `ctx.provide('agenthub/auth', service)`。

## 依赖方向

`@agenthub/_shared`（仅）；被 `@agenthub/rbac`、`@agenthub/ui` 依赖。
