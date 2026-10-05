-- =============================================================================
-- 0006_migrations_sessions · 登录会话（真登录）
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.1 + .ai-spec 20-security.md SEC-4
--   - sessions 表承载 HttpOnly Cookie 登录态；TTL 24h，每次访问滑动续期
--   - id 即 Cookie 中的会话令牌（UUID，gen_random_uuid 不可预测）
--   - 过期由 @agenthub/auth 在解析时校验 expires_at（懒过期，不做后台清扫）
-- =============================================================================

-- migrate:up
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话清理 / 按用户吊销查询
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- migrate:down
DROP TABLE IF EXISTS sessions;
