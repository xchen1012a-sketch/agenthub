# 原型 data.js → API 契约表（AgentHub UI 接入 · 前置任务 4）

> **SSOT 关系**：字段级语义的唯一事实来源是迁移文件与实现代码（`packages/agenthub/migrations/sql/` + 各包 `src/types.ts`），规范不重复字段清单（`.ai-spec` SPEC-2）；本表只定"原型 mock → endpoint / 枚举 / 阶段"的映射。
> 所有 endpoint 在 `/agenthub/api/` 前缀下（`.ai-spec/40-extension.md` EXT-1）；错误响应统一 `{ code, message, traceId }`（EXT-9）；写接口过 CSRF（`.ai-spec/20-security.md` SEC-5）。
> 原型：`原型/assets/js/data.js`（18 类 mock 实体）。身份一律取登录态（`.ai-spec/20-security.md` BND-2），请求不传 userId。

## 1. 枚举映射（原型中文 → API/DB）

| 域 | 原型值 → API 值 |
| --- | --- |
| 连接状态 | 正常→`healthy`；降级→`degraded`（D18：真值域仅此二值；`failed` 无存储来源，不派生） |
| 连接类型 | `openapi`→`openapi`；`manual`→`manual`（D18：服务端 `ConnectionHealthRecord.type` 仅 `openapi`/`manual`，DB 无 `mcp` 存储列） |
| Tool 风险 | READ→`read`；WRITE→`write`；CRITICAL→`critical`；（+`sensitive`，D18：0007 四值 `read/write/sensitive/critical`） |
| Tool 状态 | 启用→`enabled`；草稿→`draft`；禁用→`disabled`（D18：服务端 `ToolRecord.status` 仅三值，无 `test_failed`） |
| 审批状态 | 待审批→`pending`；已通过→`approved`；已拒绝→`rejected`；（+`expired`） |
| Project 状态 | 正常→`active`；未绑定系统→`unbound`；系统连接失败→`connection_failed`；已归档→`archived` |
| 我的连接 | 未连接→`not_connected`；连接中→`connecting`；已连接→`connected`；Token 即将过期→`expiring`；Token 已过期→`expired`；授权失败→`auth_failed` |
| Badcase | 待处理→`open`；已修复→`resolved`（D18：服务端 `BadcaseRecord.status` 仅二值） |
| 归因分类 | Tool 选错→`wrong_tool`；参数错误→`bad_param`；外部接口问题→`upstream_error`；权限问题→`permission_denied`；模型理解错误→`model_misunderstanding`；提示注入→`prompt_injection`；超时→`timeout`；未知→`unknown`（D18：0012 `badcases.category` 八态真值域） |
| Session 状态 | 由原生 Session 体系管理（`running/completed/error`），不走本表 |

> **D18 说明**：上述 `ToolRisk` / `ToolStatus` / `ConnectionHealthRecord.type` / `ConnectionHealthRecord.status` / `BadcaseRecord.status` / `BadcaseCause` 已向 DB 真值域收敛（`ui/src/client/api.ts` 类型定义），不再映射原型多出的 `test_failed` / `failed` / `investigating` / `regressed` 及原型归因 6 值。

## 2. 实体 → endpoint 映射

| data.js 实体 | endpoint（方法） | 关键字段（原型 → API） | 后端包 | UI 阶段 |
| --- | --- | --- | --- | --- |
| connections | `GET/POST /agenthub/api/connections`；`POST /agenthub/api/connections/scan`；`POST /:id/test`；`PATCH /:id` | name/baseUrl/type/auth/status/tools/lastCheck → 同名（status 走枚举；tools 由服务端聚合） | system-connector | P3 |
| scanResult / scanDrafts | `POST …/connections/scan` 返回分组；`GET /agenthub/api/tool-drafts`；`POST /tool-drafts/:id/publish` | total/groups；drafts 的 api/method/path/risk → 同名（risk 枚举） | openapi-ingest | P3 |
| tools | `GET /agenthub/api/tools`；`PATCH /:id`（risk/approval/status/name/desc）；`POST /:id/test` | name/api/method/path/source/risk/approval/status/usedBy/desc/params/result → 同名；`usedBy` 服务端聚合 | openapi-ingest + project-tool-scope | P3（草稿审核）→ P4（全量） |
| approvals | `GET /agenthub/api/approvals`；`POST /:id/approve`；`POST /:id/reject` | user→`userId`；project→`projectId`；tool/toolApi→`toolName`（wire 名）；risk/detail/time→ 同名语义化（`createdAt`） | approval | P3 |
| myConnections | `GET /agenthub/api/my/connections`；`POST /:id/reauth`；`DELETE /:id` | system→`connectionId`；account→`accountLabel`（脱敏）；status/expire→ 同名（枚举） | credential-vault | P3 |
| projects | `GET/POST /agenthub/api/projects` | name/system→`name`/`connectionId`；members/sessions/tools/memoryCount→ 服务端聚合；status/lastUsed/desc → 同名 | project | P2（service 已有，SSR 表单迁 JSON） |
| projectMembers | `GET/POST/DELETE /agenthub/api/projects/:id/members` | name/role/email/joined → `userId`/`role`/`email`/`joinedAt` | rbac | P4 |
| tools（Project Tool Set） | `GET/PUT /agenthub/api/projects/:id/tool-set` | 勾选集合 → `toolIds[]`；fail-closed 提示为 UI 文案 | project-tool-scope | P3（后端）→ P4（设置 tab） |
| agents（Project Agent tab） | `GET/PUT /agenthub/api/projects/:id/agent` | name/model/desc/skills/mcp/approval → 同名语义化；toolsScope 固定 `project`（A5） | project | P4 |
| memories | `GET/POST/PATCH/DELETE /agenthub/api/projects/:id/memories` | content/source/locked/updated → 同名（`sourceSessionId`、`updatedAt`；软删走 `metadata.deleted`） | project-memory | P4 |
| files | `GET/POST/DELETE /agenthub/api/projects/:id/files` | name/size/type/inCtx → 同名（`inContext`） | attachment（上游） | P4 |
| logs（执行日志） | `GET /agenthub/api/audit`（project/user/tool/status/risk/时间筛选 + 分页） | time/user/project/tool/api/risk/status/dur/session/agent/params/result/trace → `audit_records` 列语义；**params/result 脱敏后返回**；trace = 审计事件流 | audit | P4 |
| badcases | `GET /agenthub/api/badcases`；`POST /agenthub/api/badcases`（从审计/聊天标记）；`POST /:id/resolve` | q/a/tool/toolResult/cause/causeDetail/feedback/project/session/user/memory → 语义化列；status 枚举 | audit | P5 |
| analytics | `GET /agenthub/api/analytics?window=` | kpi 六指标 / toolTrend / successTrend / topTools / failCauses / topProjects → 同名（时间窗聚合） | analytics | P5 |
| users / roles | `GET /agenthub/api/admin/users`、`/roles` | name/email/role/status/last；members/builtin | rbac | 预留（原型 v2 未含全局页） |
| skills / mcpServers | `GET /agenthub/api/skills`、`/mcp-servers` | name/desc/version/usedBy；server/status/tools | skill / mcp（上游） | 预留（数据模型在，页面后补） |
| chatScripts / seedSessions | **不进 API** | 演示脚本映射为真实事件状态机（tool/approval/connect/memory 四类，见落地方案 §3.4）；seedSessions 由原生 Session 体系承担 | — | — |

## 3. 客户端消费方式

- 面板组件内 `fetch('/agenthub/api/…')` 同源携带 AgentHub Cookie；401 → 引导回 `/agenthub/login`；403/4xx → 按 U5 envelope 渲染错误文案。
- 列表页统一 JSON 分页约定：`{ items, total }` + query `page/size`（与审计页 50/页对齐）。
- 提交类操作（审批通过/拒绝、发布草稿、勾选 Tool Set）POST/PATCH 后按响应刷新本地视图，不做全页刷新。
