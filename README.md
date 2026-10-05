# AgentHub

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的企业 AI Agent 中控台：在「一切皆插件」（Cordis）底座上，对接 CRM / ERP / OMS / SaaS，统一身份、项目、工具、凭证与审计。

| 项 | 说明 |
| --- | --- |
| 架构 | 单仓库、单 Web/Host 进程；业务在 `packages/agenthub/*` 分包，部署仍是一个应用 |
| 数据 | 单一 PostgreSQL（建议 16+）+ pgvector |
| Web 默认端口 | `5080`（`http://127.0.0.1:5080`） |
| 规范入口 | 本仓库内 `packages/agenthub` 相关约束见 `.ai-spec/`（AgentHub SSOT） |

上游 Harness 通用文档仍见 [deepseek-harness 文档站](https://deepseek-harness.github.io/deepseek-harness/)；本 README 只说明 **AgentHub 二开** 的克隆、建库与启动。

---

## 能力概览

- 平台用户、角色与 Project 成员（RBAC）
- Project 与 Harness Workspace 1:1
- 外部系统连接、浏览器登录会话、凭证保险箱（AES-256-GCM）
- OpenAPI 导入与按 Project 裁剪工具
- 风险分级、审批、审计、Badcase
- Project Memory（pgvector / halfvec）

---

## 环境要求

- **Node.js** `^22.19.0` 或 `>=24.0.0`
- **pnpm** `11.7.0`（见仓库 `packageManager` 字段）
- **PostgreSQL 16+**，并安装 **pgvector** 扩展（迁移 `0001` 会 `CREATE EXTENSION`）

---

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/xchen1012a-sketch/agenthub.git
cd agenthub
pnpm install
pnpm run build
```

> 若你使用「外层 AgentHub + 内层 `deepseek-harness`」的完整桌面布局，请在 **`deepseek-harness` 目录内**执行安装与构建；下文路径均相对于 **本仓库根目录**（即 `deepseek-harness` / GitHub 上的 `agenthub`）。

### 2. 准备 PostgreSQL

任选一种方式：

**方式 A — Docker（推荐）**

在**本仓库的上一级目录**创建 `deploy`（启动脚本默认读取 `../deploy/.env`）：

```bash
# 假设当前在 agenthub 仓库根目录
mkdir -p ../deploy
```

将下列内容写入 `../deploy/.env`（密码自行修改）：

```env
AGENTHUB_DB_PASSWORD=你的强密码
AGENTHUB_DB_URL=postgres://agenthub:你的强密码@localhost:5432/agenthub
AGENTHUB_VAULT_MASTER_KEY=   # Base64，解码后 32 字节
AGENTHUB_COOKIE_SECRET=      # 至少 32 字节随机字符串
AGENTHUB_LLM_API_KEY=        # 模型 API Key
```

若你本地有 `deploy/docker-compose.yml`（完整工作区里的 `AgentHub/deploy/`），可在该目录执行：

```bash
docker compose -f deploy/docker-compose.yml up -d postgres
```

仅 clone 本 GitHub 仓库、没有 compose 文件时，可自行启动 `pgvector/pgvector:pg16` 镜像，并保证库名、用户与 `AGENTHUB_DB_URL` 一致。

**方式 B — 已有 Postgres**

设置环境变量 `AGENTHUB_DB_URL`（或写入 `../deploy/.env`），确保库已创建且账号可连。

### 3. 执行数据库迁移（建表）

表结构**唯一事实来源**：`packages/agenthub/migrations/sql/`（当前 **0001–0020**）。

```bash
pnpm --filter @agenthub/migrations run dbmate:up
pnpm --filter @agenthub/migrations run dbmate:status
```

`status` 应显示全部迁移已应用。回滚一步：`pnpm --filter @agenthub/migrations run dbmate:rollback`。

连接串规则：优先 `AGENTHUB_DB_URL`；未设置时 runner 会尝试加载 **`../deploy/.env`**。详见 `packages/agenthub/migrations/README.md`。

### 4. 启动 Web

```bash
pnpm start:agenthub          # 不自动打开浏览器
# 或
pnpm start:agenthub:open     # 打开浏览器
```

访问：**http://127.0.0.1:5080**

启动命令会通过 `--env-file-if-exists=../deploy/.env` 加载配置；未使用 `deploy` 文件时，请在本机 **export 同等环境变量**。

---

## 目录说明（AgentHub 相关）

```
.
├── apps/
│   ├── cli/                          # dsh CLI
│   └── web/                          # Web 入口；AgentHub 使用 config/agenthub.yaml
├── apps/web/config/agenthub.yaml     # AgentHub Cordis Profile / Patch
├── packages/
│   ├── agenthub/                     # ★ AgentHub 自有代码（可改）
│   │   ├── migrations/               # PostgreSQL 迁移（dbmate）
│   │   ├── auth/ rbac/ project/
│   │   ├── system-connector/ credential-vault/
│   │   ├── openapi-ingest/ project-tool-scope/
│   │   ├── project-memory/ approval/ audit/ ui/ …
│   │   └── …
│   ├── core/ session/ workspace/ …   # 上游 Harness（勿改内部实现）
│   └── …
├── .ai-spec/                         # AgentHub 规范 SSOT
└── package.json                      # start:agenthub 等脚本
```

**分包策略**：功能按 `packages/agenthub/<域>` 划分，进程与部署仍是一个应用（见 `.ai-spec/10-architecture.md` ARCH-1）。不要拆成多个独立部署的运行时。

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm start:agenthub` | AgentHub Web，`5080`，不打开浏览器 |
| `pnpm start:agenthub:open` | 同上并打开浏览器 |
| `pnpm --filter @agenthub/migrations run dbmate:up` | 应用全部迁移 |
| `pnpm exec vitest run packages/agenthub` | 运行 AgentHub 包测试（示例） |

---

## 环境变量（必填摘要）

| 变量 | 用途 |
| --- | --- |
| `AGENTHUB_DB_URL` | PostgreSQL 连接串 |
| `AGENTHUB_VAULT_MASTER_KEY` | 凭证加密主密钥（Base64，32 字节） |
| `AGENTHUB_COOKIE_SECRET` | 会话 Cookie 签名 |
| `AGENTHUB_LLM_API_KEY` | 默认 LLM 调用 |

完整说明与生成方式见完整工作区中的 `deploy/.env.example`（若你只有本仓库，可按上文「快速开始」自行填写 `../deploy/.env`）。

---

## 与上游 DeepSeek Harness 的关系

- 本仓库在 Harness 源码树之上包含 **AgentHub 二开**；上游包遵循只读边界（`.ai-spec/10-architecture.md` ARCH-2）。
- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 许可证：沿用上游 MIT；AgentHub 自有代码同为 MIT（见 `LICENSE`）。

---

## 故障排查

| 现象 | 建议 |
| --- | --- |
| 迁移报 `AGENTHUB_DB_URL 未设置` | 设置环境变量或创建 `../deploy/.env` |
| 启动后无法登录 / 加解密失败 | 检查 `AGENTHUB_COOKIE_SECRET`、`AGENTHUB_VAULT_MASTER_KEY` 是否固定且长度合法 |
| 向量 / Memory 相关错误 | 确认 Postgres 已装 pgvector，且迁移 0001、0014、0015 已执行 |
| 端口占用 | 修改 `AGENTHUB_PORT` 或启动参数 `--port` |

---

## 参与开发

- 接任务前阅读：`.ai-spec/_index.md`，再按改动阅读 `00`–`60` 编号规则。
- AI / 协作者入口：仓库根 `AGENTS.md`（若存在）与 `.ai-spec/`。
