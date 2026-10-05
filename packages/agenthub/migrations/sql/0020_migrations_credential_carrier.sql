-- =============================================================================
-- 0020_migrations_credential_carrier · 记下凭证在请求里的携带位置
--
-- 已应用的迁移不改。本文件只追加：
--   - carrier 是外部系统前端携带凭证所用的请求头名（小写），例如 authorization、
--     cookie、x-token；它本身不是秘密，凭证值仍只在 encrypted_payload 里
--   - 旧行没有 carrier，调用时按连接的认证方式决定携带位置
-- =============================================================================

-- migrate:up
ALTER TABLE user_credentials
  ADD COLUMN IF NOT EXISTS carrier TEXT;

ALTER TABLE user_credentials
  ADD CONSTRAINT chk_user_credentials_carrier
  CHECK (carrier IS NULL OR carrier ~ '^[a-z0-9][a-z0-9-]{0,63}$');

-- migrate:down
ALTER TABLE user_credentials DROP CONSTRAINT IF EXISTS chk_user_credentials_carrier;
ALTER TABLE user_credentials DROP COLUMN IF EXISTS carrier;
