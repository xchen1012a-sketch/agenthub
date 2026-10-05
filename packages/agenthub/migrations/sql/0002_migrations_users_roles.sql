-- =============================================================================
-- 0002_migrations_users_roles · 用户 / 角色 / 用户角色绑定
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.1
--   - users / roles / user_roles；不含 sessions 表（P2 真登录时再建）
--   - 种子：4 条基础角色（platform_admin / project_admin / member / approver）
--   - password_hash 为 Argon2id 摘要；P1 dev 匿名阶段由应用层写入占位值
-- =============================================================================

-- migrate:up
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (name IN ('platform_admin', 'project_admin', 'member', 'approver')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- 外键字段建索引（.ai-spec 30-data.md DATA-3 SHOULD）
CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);

-- 种子：4 条基础角色（幂等）
INSERT INTO roles (name) VALUES
  ('platform_admin'),
  ('project_admin'),
  ('member'),
  ('approver')
ON CONFLICT (name) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
