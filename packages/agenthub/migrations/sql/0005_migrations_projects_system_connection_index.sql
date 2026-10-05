-- =============================================================================
-- 0005_migrations_projects_system_connection_index · Project 系统连接外键索引
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-3
--   - 外键字段建立索引
--   - 作为追加迁移修复已应用的 0004，不修改既有迁移历史
-- =============================================================================

-- migrate:up
CREATE INDEX idx_projects_system_connection ON projects(system_connection_id);

-- migrate:down
DROP INDEX IF EXISTS idx_projects_system_connection;
