-- =============================================================================
-- 0008_migrations_audit_records · 审计记录
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.7
--   - 与阶段书差异（docs/AgentHub_P2技术方案 §3 D5）：
--     approval_id 列推迟到 P3 迁移补建（approvals 表 P3 才存在，FK 无法前向引用）
--   - args / result_meta 由 @agenthub/audit 经白名单脱敏后写入（.ai-spec 20-security.md SEC-1）
--   - project_id / user_id / tool_id ON DELETE SET NULL：审计是留存记录，
--     不随业务对象删除而级联消失（tool_name / 冗余列保底可追溯）
-- =============================================================================

-- migrate:up
CREATE TABLE audit_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT,
  tool_id UUID REFERENCES tools(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('read', 'write', 'sensitive', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied', 'pending')),
  trace_id TEXT NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 审计页主查询路径：按项目 + 时间倒序（.ai-spec 30-data.md DATA-3 SHOULD）
CREATE INDEX idx_audit_records_project_created ON audit_records(project_id, created_at DESC);
CREATE INDEX idx_audit_records_trace_id ON audit_records(trace_id);

-- migrate:down
DROP TABLE IF EXISTS audit_records;
