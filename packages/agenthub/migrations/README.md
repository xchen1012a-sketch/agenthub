# @agenthub/migrations

AgentHub PostgreSQL schema 版本管理包：dbmate 封装 + 迁移 SQL。

## 职责

- 维护 AgentHub 已建表的 DDL 迁移：当前 17 张表（表清单的唯一事实来源是本目录的 `sql/`，不在规范里重复）
- 通过 dbmate 执行迁移：`up` / `status` / `rollback`
- 本包不含业务代码，不导出运行时 API

## 迁移清单

| 编号 | 文件 | 内容 | 阶段 |
| --- | --- | --- | --- |
| 0001 | `0001_migrations_extensions.sql` | pgcrypto / uuid-ossp / citext / vector 扩展 | P1 |
| 0002 | `0002_migrations_users_roles.sql` | users / roles / user_roles + 4 角色种子 | P1 |
| 0003 | `0003_migrations_projects_members.sql` | projects / project_members（`harness_workspace_id` 唯一约束） | P1 |
| 0004 | `0004_migrations_system_connections.sql` | system_connections（只建表）+ 补挂 projects FK | P1 |
| 0005 | `0005_migrations_projects_system_connection_index.sql` | 为 `projects.system_connection_id` 外键补索引（前向修复） | P1 |
| 0006 | `0006_migrations_sessions.sql` | sessions 登录会话（Argon2id + 签名 Cookie，TTL 24h 滑动续期） | P2 |
| 0007 | `0007_migrations_tools.sql` | tools / project_tool_set（Tool Registry + Project 工具集） | P2 |
| 0008 | `0008_migrations_audit_records.sql` | audit_records（工具事件审计，脱敏落库） | P2 |
| 0009 | `0009_migrations_harness_sessions.sql` | agenthub_sessions / agenthub_session_events（Session 持久化替换 jsonl） | P2 |
| 0010 | `0010_migrations_user_credentials.sql` | user_credentials（AES-256-GCM 密文 + key_version + 用户×连接唯一） | P3 |
| 0011 | `0011_migrations_approvals.sql` | approvals（status 四态 + expires_at 默认 now()+1h） | P3 |
| 0012 | `0012_migrations_badcases.sql` | badcases（category 八态 CHECK） | P3 |
| 0013 | `0013_migrations_audit_records_approval_id.sql` | audit_records 补挂 approval_id + auth_mode 扩展 session（D14） | P3 |
| 0014 | `0014_migrations_project_memories.sql` | project_memories（pgvector embedding + metadata + locked + ivfflat 索引） | P4 |
| 0015 | `0015_migrations_project_memories_dim.sql` | project_memories 向量改 `halfvec(2048)` + HNSW 索引（2048 维超出 `vector` 的 2000 维索引上限） | P4 |

## 使用

```sh
# 1. 启动数据库
docker compose -f deploy/docker-compose.yml up -d postgres

# 2. 配置连接串（复制 deploy/.env.example 为 deploy/.env，填 AGENTHUB_DB_URL）
#    runner 会自动加载 deploy/.env；连接串仅经 DATABASE_URL 子进程环境变量传递
#    本地地址缺省补 sslmode=disable，远程地址保留调用方显式 SSL 配置

# 3. 执行迁移 / 查看状态 / 回滚一步
pnpm --filter @agenthub/migrations run dbmate:up
pnpm --filter @agenthub/migrations run dbmate:status
pnpm --filter @agenthub/migrations run dbmate:rollback
```

## 迁移规范

规则的唯一陈述地是 `.ai-spec/30-data.md`（`DATA-1`–`DATA-7`）与 `40-extension.md`（`EXT-3`）。本文件不重复规则，只给出最常查的两条指针：

- 命名与排序 → `DATA-3`
- 已应用的迁移不得改动、必须成对 UP/DOWN → `DATA-2`

静态约束由 `tests/migrations.spec.ts` 守护。
