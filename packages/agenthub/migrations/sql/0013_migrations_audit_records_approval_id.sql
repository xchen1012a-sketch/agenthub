-- =============================================================================
-- 0013_migrations_audit_records_approval_id · 审计关联审批 + auth_mode 扩展
-- （P3 方案书阶段 A T1 / 差异登记 D5+D14）
--
-- 1) audit_records 补挂 approval_id（P2 D5 推迟项：approvals 表 0011 才存在，
--    FK 无法前向引用）——审计是留存记录，审批删除不连带删审计（SET NULL）。
-- 2) system_connections.auth_mode 扩展 'session'（D14 反向代理授权捕获）。
--    0004 为内联列 CHECK，PostgreSQL 自动命名 system_connections_auth_mode_check，
--    扩值只能整条替换。
-- =============================================================================

-- migrate:up
ALTER TABLE audit_records
  ADD COLUMN approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL;

CREATE INDEX idx_audit_records_approval_id ON audit_records(approval_id);

ALTER TABLE system_connections DROP CONSTRAINT IF EXISTS system_connections_auth_mode_check;
ALTER TABLE system_connections
  ADD CONSTRAINT system_connections_auth_mode_check
  CHECK (auth_mode IN ('oauth2', 'oidc', 'api_login', 'pat', 'cookie', 'session'));

-- migrate:down
ALTER TABLE system_connections DROP CONSTRAINT IF EXISTS system_connections_auth_mode_check;
ALTER TABLE system_connections
  ADD CONSTRAINT system_connections_auth_mode_check
  CHECK (auth_mode IN ('oauth2', 'oidc', 'api_login', 'pat', 'cookie'));
DROP INDEX IF EXISTS idx_audit_records_approval_id;
ALTER TABLE audit_records DROP COLUMN IF EXISTS approval_id;
