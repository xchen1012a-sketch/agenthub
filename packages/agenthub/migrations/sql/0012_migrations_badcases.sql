-- =============================================================================
-- 0012_migrations_badcases · 坏例登记（P3 方案书阶段 A T1）
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.7
--   - category 八态 CHECK（wrong_tool / bad_param / upstream_error /
--     permission_denied / model_misunderstanding / prompt_injection / timeout / unknown）
--   - audit_id NOT NULL：坏例必须挂审计记录；审计删除则坏例随之消亡（业务表 CASCADE）
-- =============================================================================

-- migrate:up
CREATE TABLE badcases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audit_records(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'wrong_tool', 'bad_param', 'upstream_error', 'permission_denied',
    'model_misunderstanding', 'prompt_injection', 'timeout', 'unknown'
  )),
  category_note TEXT,
  ai_summary TEXT,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_badcases_audit_id ON badcases(audit_id);

-- migrate:down
DROP INDEX IF EXISTS idx_badcases_audit_id;
DROP TABLE IF EXISTS badcases;
