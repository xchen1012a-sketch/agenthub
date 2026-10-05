-- =============================================================================
-- 0001_migrations_extensions · PostgreSQL 扩展
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-3
--   - pgcrypto  : UUID 主键 gen_random_uuid()
--   - uuid-ossp : UUID v4
--   - vector    : pgvector 向量检索（pgvector/pgvector:pg16 镜像自带）
--   - citext    : users.email CITEXT 类型（§3.1 字段类型 MUST 要求）
-- =============================================================================

-- migrate:up
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- uuid-ossp 含连字符，标识符必须加双引号
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

-- migrate:down
DROP EXTENSION IF EXISTS vector;
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS "uuid-ossp";
DROP EXTENSION IF EXISTS pgcrypto;
