---
title: AgentHub 架构边界
description: 架构层不允许越过的线：单主工程、上游包只读、依赖方向、默认禁用能力
lastUpdated: 2026-10-03
---

# 架构边界（`10-architecture.md`）

> 本文件写"架构上不许怎么样"。**做法（目录怎么建、进程怎么起、代码怎么写）不在此列**——那由实现者决定。

---

## ARCH-1 单主工程（✅ MUST）

**禁止**把 AgentHub 拆成多个需要独立部署的运行工程。

**必须**保持：一个仓库、一个 Web/Host 运行入口、功能按 `packages/agenthub/*` 分包但部署为一个应用。

**为什么**：多入口会让身份、审计、凭证出现多份运行态，`BND-1`–`BND-4` 无法统一保证。

---

## ARCH-2 上游包只读（✅ MUST）

**禁止**修改上游包内部实现，范围包括 `packages/core/`、`packages/session/`、`packages/workspace/`、`packages/tool/`、`packages/credentials/`、`packages/interaction/`、`packages/storage/`、`packages/host/`、`packages/api/`。

**禁止**从上游包的 `src/` 内部路径 import。

**必须**只通过上游公开的 Service / Hook / Slot 扩展。

**唯一的例外**：`packages/agenthub/**` 是 AgentHub 自有代码，不受本约束。

**为什么**：改上游内部会让"升级上游"变成重写；公开 seam 是上游承诺的稳定面。

---

## ARCH-3 依赖方向单一（✅ MUST）

允许的依赖方向只有一条：`apps/` → `packages/agenthub/*` → 上游公开 API。

**禁止**：

- 上游包反向依赖 `agenthub/*`
- `agenthub/*` 之间出现循环依赖
- `agenthub/*` 直接 import 上游包的 `src/` 内部路径

**为什么**：依赖成环会让加载顺序不可判定，也让"只读上游"失效。

---

## ARCH-4 配置只能通过 overlay 注入（✅ MUST）

**禁止**通过修改上游源码来改变 AgentHub 的运行形态（端口、插件装载、禁用能力等）。

**必须**通过 profile 层与 `--patch` overlay 实现，overlay 文件放在 `deploy/` 或 `apps/web/config/`。

**为什么**：改上游源码会在下次同步上游时被冲掉，且违反 `ARCH-2`。

---

## ARCH-5 默认禁用能力不得启用（✅ MUST）

下列上游能力在 AgentHub 中**必须保持禁用**：Shell / Jobs 类工具、Desktop / Computer Use、Browser Use、Voice Input、Agent Team、Auto Review。

**禁止**启用它们，除非同时满足：① 该能力的执行入口被 Project 级审批链完整覆盖；② 已在 `_index.md` §4 登记为例外。

**为什么**：这些能力能绕过工具审批链直接触达宿主环境，是 `BND-3` 的直接反例。

---

## ARCH-6 运行时依赖必须显式声明（✅ MUST）

插件之间、插件对上游服务的**运行时依赖必须通过 `inject` 声明**。

**禁止**只依赖配置文件中的注册顺序来保证依赖可用。

**为什么**：注册顺序是配置事实，会被重排；`inject` 是运行时契约，缺服务时会在最早的时点失败而不是运行到一半才 undefined。

---

## ARCH-7 配置错误必须响亮失败（✅ MUST）

**禁止**在缺少必需依赖或配置时静默跳过、静默降级为"功能不可用但不报错"。

**必须**在自身可判定时于加载期失败，否则在最晚可解析的时点失败。

**唯一允许的降级**：该能力被显式配置为关闭，或降级本身已被本目录某条规则明确允许（如记忆检索失败不得阻断对话）。

**为什么**：静默降级会让人以为功能正常，问题被推迟到生产。
