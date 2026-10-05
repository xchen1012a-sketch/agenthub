-- =============================================================================
-- 0009_migrations_harness_sessions · Harness Session 持久化（P2 方案书 T8）
--
-- 规范：P2 方案书 §5 T8 + D4 修正（表结构以 SessionPersistence 真实契约为准，
--   主表 + 事件追加，主键为 Harness Session ID TEXT；.ai-spec 30-data.md DATA-1.8
--   的 agenthub_session_events 预写结构由 T8 实现后回写修订）。
--   - @agenthub/postgres-session-provider 以同一 service contract 落库：
--     create/open/flush/stat/list + handle（append 逐批追加，永不改写）
--   - 事件只追加：PK (session_id, seq) 保证连续性由 provider 断言
--   - 替换 base bundle 的 session-persistence-jsonl，Session 不再落 JSONL 文件
-- =============================================================================

-- migrate:up
CREATE TABLE agenthub_sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  header JSONB NOT NULL,
  inherited_event_count BIGINT NOT NULL DEFAULT 0,
  event_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agenthub_session_events (
  session_id TEXT NOT NULL REFERENCES agenthub_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- migrate:down
DROP TABLE IF EXISTS agenthub_session_events;
DROP TABLE IF EXISTS agenthub_sessions;
