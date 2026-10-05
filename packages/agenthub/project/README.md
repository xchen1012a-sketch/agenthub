# @agenthub/project

Project 领域包（P1：内存版 Workspace）。

## 职责

- `createProject`：名称校验 → 写 `projects` + 创建者 `project_members`（admin）→ 注册内存 Workspace（`mem:<uuid>`）→ 发 `agenthub/project.created` 事件（events-bus §2）。
- `resolveProjectContext`：404 / 非成员 403（fail-closed）→ `{ projectId, workspaceId, role }`。
- `listProjects`：创建者视角列表。
- `MemoryWorkspaceRegistry`：进程内 `projectId → workspaceId` 映射，P2 替换为上游 `packages/workspace` 真实句柄。

## 非职责（P2 起）

- 真实 Harness Workspace 创建、Tool 挂载（P2）。

## 公开 API

- `ProjectService` / `MemoryWorkspaceRegistry` / `PostgresProjectRepository`。
- 领域类型：`ProjectRecord` / `ProjectContext` / `MemberRole` / `Queryable`。

## 依赖方向

`@agenthub/_shared`（仅）；运行时依赖 `pg`（连接串 `AGENTHUB_DB_URL`）；被 `@agenthub/ui` 依赖。
