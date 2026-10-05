# @agenthub/approval

审批链路闭环：pre-execute 策略判定 `ask` → 落库 `approvals` pending → 管理台决策 → Tool 放行 / 阻断（P3 方案书阶段 B）。

## 行为

- **策略判定（fail-closed）**：`requires_approval=true` 或 `risk_level ≥ minRiskLevel`（默认 `write`）→ 送审 `ask`；未知 `risk_level` 视为 `critical`。判定只读 `tools` 表字段与插件配置，不由模型入参决定（security.md §2.1）。
- **挂起与结算**：`tools/pre-execute` 判定 ask 后按 callId 暂存执行上下文，`approval/request` waterfall 消费并落库 pending + 发 `approval.requested`，返回挂起 Promise；`decide` 首次生效（二次 409），超时与孤儿 pending 均置 `expired` —— 两条路径都以 **deny** 方向结算。
- **Project 维度**：审批人资格 = 平台 `approver` 角色 ∪ 该项目 `project_members` 的 `admin`/`approver`。`decide` 先取审批所属 Project 再校验资格，跨 Project 一律 403；`listApprovals` 只返回查看者可审批 Project 的行（平台 approver 为全局）。
- **启动校验**：`failClosed=true` 时配置非法或全库无审批人 → 抛错，启动失败；启动时把遗留 pending 统一置 expired（deny）。
- **脱敏**：落库的 `approvals.args` 与 `approval.requested` payload 均过 `_shared/redact`（深层递归）。

## 用法

```yaml
# agenthub.yaml 插件顺序：… → project-tool-scope → approval → audit → …
agenthub:
  approval:
    failClosed: true      # 默认 true：无审批人即拒绝启动
    timeoutHours: 1       # 默认 1：到期未决 → expired（deny）
    minRiskLevel: write   # 默认 write：read 不送审
```

决策通道由 `@agenthub/ui` 暴露：`GET /agenthub/api/approvals`（按查看者 Project 范围过滤，`status` 可选）、`POST /agenthub/api/approvals/:id/decide`（CSRF 双提交 + U5 envelope）。对话内审批卡不出现（D7：管理台为唯一决策通道）。