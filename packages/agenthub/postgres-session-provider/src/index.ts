/**
 * @agenthub/postgres-session-provider —— Harness Session 持久化的 Postgres 后端。
 *
 * P2 范围（P2 方案书 T8）：实现 SessionPersistence 同一 service contract
 * （create/open/flush/stat/list + handle 语义），替换 base bundle 的
 * session-persistence-jsonl；表结构见迁移 0009_migrations_harness_sessions.sql。
 *
 * @module @agenthub/postgres-session-provider
 */
export { name, inject, apply } from './plugin.ts'
export { PostgresSessionPersistence, PgSessionHandle } from './service.ts'
