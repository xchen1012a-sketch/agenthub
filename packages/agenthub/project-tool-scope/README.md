# @agenthub/project-tool-scope

Tool 装载 + Project 级可见性隔离 + 工具事件转发（P2 方案书 T6）。

## 职责

- **Tool 装载**：3 个手动示例 Tool（`echo_read` / `noop_write` / `noop_sensitive`，对应迁移 0007 种子）经上游公开 `ctx.tools.register()` 注册到全局 Registry。
- **per-Session 隔离（V4）**：上游无 per-session 注册 API（D2），用 `scope.ctx.tools.restrict({ allow })` 实现；allow = `tools(enabled) ∩ project_tool_set`，fail-closed（空 Tool Set → 全禁）。
- **事件转发（D3）**：监听上游 `tools/pre-execute` / `tools/post-execute`，补齐服务端身份/项目上下文后发 `agenthub/tool.before-execute` / `agenthub/tool.after-execute`；audit 只订阅 agenthub 事件。

## 服务

`agenthub/tool-scope` → `SessionToolScopeService`：

- `open(projectId, userId, sessionId, key)`：打开 Session 的 Tool scope（binding + restriction）。
- `bindingOf(key)`：hooks 补齐身份/项目上下文用。
- `close(key)`：解除隔离并移除绑定。

## 用法

```ts
import { name, inject, apply } from '@agenthub/project-tool-scope'

// agenthub.yaml 插件顺序：auth → rbac → project → project-tool-scope → …
// Session 打开时（服务端已知登录身份，.ai-spec 20-security.md BND-2）：
const handle = await scopes.open(projectId, user.userId, sessionId, agentKey)
```

## 测试

```bash
pnpm exec vitest run packages/agenthub/project-tool-scope
```
