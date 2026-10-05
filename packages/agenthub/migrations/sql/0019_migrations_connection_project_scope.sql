-- =============================================================================
-- 0019_migrations_connection_project_scope · 连接归属项目，并分开记录登录地址
--
-- 已应用的迁移不改。本文件只追加：
--   - 既有连接只有一个地址，登录地址先等于该地址，之后可由管理员改成真正的前端地址
--   - 一条连接被多个项目指向时不猜测归属：这些指向全部解开，连接停用直到重新指定
--   - 一个项目最多一条连接（部分唯一索引）
--   - 工具名在所属连接内唯一；没有连接的手工工具仍按名字全局唯一
-- =============================================================================

-- migrate:up
ALTER TABLE system_connections
  ADD COLUMN IF NOT EXISTS frontend_url TEXT;

UPDATE system_connections
SET frontend_url = base_url
WHERE frontend_url IS NULL;

ALTER TABLE system_connections
  ALTER COLUMN frontend_url SET NOT NULL;

UPDATE projects
SET system_connection_id = NULL
WHERE system_connection_id IN (
  SELECT system_connection_id
  FROM projects
  WHERE system_connection_id IS NOT NULL
  GROUP BY system_connection_id
  HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_one_connection
  ON projects (system_connection_id)
  WHERE system_connection_id IS NOT NULL;

ALTER TABLE tools DROP CONSTRAINT IF EXISTS tools_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_name_per_connection
  ON tools (system_connection_id, name)
  WHERE system_connection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_name_without_connection
  ON tools (name)
  WHERE system_connection_id IS NULL;

-- migrate:down
DROP INDEX IF EXISTS idx_tools_name_without_connection;
DROP INDEX IF EXISTS idx_tools_name_per_connection;
ALTER TABLE tools ADD CONSTRAINT tools_name_key UNIQUE (name);
DROP INDEX IF EXISTS idx_projects_one_connection;
ALTER TABLE system_connections DROP COLUMN IF EXISTS frontend_url;
