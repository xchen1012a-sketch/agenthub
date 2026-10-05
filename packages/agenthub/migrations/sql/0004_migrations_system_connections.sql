-- =============================================================================
-- 0004_migrations_system_connections · 系统连接（P1 只建表，无业务数据）
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.3
--   - auth_mode 五态枚举 CHECK
--   - mcp_servers 默认 '[]'
--   - 同时补挂 projects.system_connection_id 的 FK
--     （引用系统级配置表，ON DELETE SET NULL，见 §4 外键删除策略）
-- =============================================================================

-- migrate:up
CREATE TABLE system_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('oauth2', 'oidc', 'api_login', 'pat', 'cookie')),
  openapi_url TEXT,
  openapi_doc JSONB,
  mcp_servers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_connections_created_by ON system_connections(created_by);

ALTER TABLE projects
  ADD CONSTRAINT projects_system_connection_id_fkey
  FOREIGN KEY (system_connection_id)
  REFERENCES system_connections(id)
  ON DELETE SET NULL;

-- migrate:down
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_system_connection_id_fkey;
DROP TABLE IF EXISTS system_connections;
