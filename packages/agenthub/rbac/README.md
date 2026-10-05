# @agenthub/rbac

平台角色与 Project 成员关系包（P1：仅 `requirePlatformAdmin` 守卫）。

## 职责

- `RbacService.requirePlatformAdmin(user)`：fail-closed 守卫，非 `platform_admin` 抛 403（code `agenthub/rbac/Forbidden`）。
- 拒绝时记 `rbac.denied` 八字段日志。

## 非职责（P2 起）

- `user_roles` 表查询、Project 成员关系读写（迁移 `0002`/`0003` 已建表）。

## 公开 API

- `RbacService` / `RbacUser` / `asRbacUser` / `DEV_RBAC_USER`。
- Cordis：`apply(ctx)` → `ctx.provide('agenthub/rbac', service)`。

## 依赖方向

`@agenthub/_shared` + `@agenthub/auth`（强依赖：需查询用户身份，plugin-skeleton §3）；被 `@agenthub/ui` 依赖。
