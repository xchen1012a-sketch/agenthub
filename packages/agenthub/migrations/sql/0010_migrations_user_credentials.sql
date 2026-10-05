-- =============================================================================
-- 0010_migrations_user_credentials · 凭证 Vault（P3 方案书阶段 A T1）
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.5
--   - encrypted_payload 为 AES-256-GCM 密文（BYTEA），明文绝不落库；
--     应用层必须显式列名查询，禁止 SELECT *（§3.5 MUST）
--   - key_version 支撑 .ai-spec 20-security.md SEC-7 KEK 轮换（P3 只落 key_version=1）
--   - UNIQUE (user_id, system_connection_id)：同一用户在同一连接下仅一份凭证，
--     重复绑定走 UPSERT 覆盖
--   - users / system_connections 删除即级联删除凭证（敏感数据不残留）
-- =============================================================================

-- migrate:up
CREATE TABLE user_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  system_connection_id UUID NOT NULL REFERENCES system_connections(id) ON DELETE CASCADE,
  external_user_id TEXT,
  encrypted_payload BYTEA NOT NULL,
  key_version INT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_credentials_user_connection UNIQUE (user_id, system_connection_id)
);

CREATE INDEX idx_user_credentials_connection ON user_credentials(system_connection_id);

-- migrate:down
DROP INDEX IF EXISTS idx_user_credentials_connection;
DROP TABLE IF EXISTS user_credentials;
