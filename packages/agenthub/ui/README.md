# @agenthub/ui

AgentHub 页面包。服务端：SSR 占位页 + `/agenthub/api/*` 数据路由；客户端：五个管理页直接作为 `main` keyed 面板 + `sidebar.panellist` 入口（Tool 中心 / 系统连接 / 审批中心 / AI 运营 / 项目设置）。

## 服务端（`src/plugin.ts` / `router.ts` / `render.ts`）

- `GET /agenthub/login`：dev 登录占位页（匿名可达）。
- `POST /agenthub/login`：dev 匿名登录 → 302 `/agenthub/projects`。
- `GET /agenthub/projects`：Project 列表（auth 身份 + rbac `requirePlatformAdmin`）。
- `POST /agenthub/projects`：新建 Project（V3：DB 行 +1，`mem:<uuid>`）→ 302 详情。
- `GET /agenthub/projects/<id>`：详情空壳（`resolveProjectContext` 成员校验，非成员 403）。

## 约定

- 路径 U2：全部在 `/agenthub` 前缀下（上游 `ctx.webServer` prefix 路由，优先于 SPA fallback）。
- i18n U4：`src/i18n.ts` en / zh 双语同步，`pickLocale(Accept-Language)`。
- 渲染：`src/render.ts` 全部插值过 `escapeHtml`。

## 公开 API

- 服务端：`handleAgenthubRequest(deps, req)`（纯 dispatch，HTTP 壳在 `plugin.ts`）；页面渲染函数 + `pickLocale` / `t`。
- 客户端：`apply(ctx)` / `inject`（cordis 客户端插件面）、`NS`。

## 客户端（`src/client/`）

- 包声明：`dsh.client`（platform web + inject 边）+ `exports["./client"]`；bundle 由 `pnpm --filter @agenthub/ui run bundle`（tsdown，共享预设 `packages/client/tsdown.client.ts`）产出 `lib/client.js`，client-modules 扫描自动装载。
- `main` keyed 面板：五页各持一个 key（`agenthub-tools` / `agenthub-connections` / `agenthub-approvals` / `agenthub-analytics` / `agenthub-project`，scope root，无 Session 绑定），管理页逐阶段迁入（落点映射见 `docs/AgentHub_UI接入落地方案` §4 与 `docs/api-contracts.md`）。
- `sidebar.panellist`：五个入口 id 与面板 key 一致、order 40–44、label 走 `agenthub` locale 命名空间；icon 组件由 `@deepseek-ai/dsh-client-ui-primitives` 提供。
- 导航：侧栏按钮由上游 sidebar 拥有（点击即 selectPanel）；深链恢复用 location hash（P3 落地）。
- i18n U4：`src/client/locales.ts` en / zh 双语同步；zh 为 key-set source of truth。
- 类型面：跨包只 `import type` 上游 `/client` 类型（slots.md Extension rules）；client bundle purity gate 禁止非 externals 的 `@deepseek-ai/*` value import。

## 测试

- 服务端：`tests/i18n.spec.ts` / `tests/router.spec.ts`（宿主聚合）。

## 依赖方向

服务端：`@agenthub/_shared` + `@agenthub/auth` + `@agenthub/rbac` + `@agenthub/project`；上游 seam `@deepseek-ai/dsh-host-webserver`。
客户端：上游 seam `dsh-client-locale` / `dsh-client-ui-layout` / `dsh-client-ui-renderer` / `dsh-client-ui-sidebar` / `dsh-client-ui-slots` / `dsh-client-ui-primitives`（devDeps，运行时经模块表）。
