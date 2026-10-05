-- =============================================================================
-- 0011_migrations_approvals · 审批记录（P3 方案书阶段 A T1）
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.7
--   - status 四态 CHECK；expires_at 默认 now() + 1h（到期未决 → expired → deny）
--   - args 为脱敏副本（落库前过 @agenthub/_shared/redact 白名单）
--   - FK 删除策略（§4）：projects / tools 为业务表 → CASCADE（对象删除则
--     工作流记录消亡）；users 为系统表 → SET NULL（审批历史保留、身份匿名化）
-- =============================================================================

-- migrate:up
CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('write', 'sensitive', 'critical')),
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  approver_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 hour')
);

CREATE INDEX idx_approvals_project_created ON approvals(project_id, created_at DESC);
CREATE INDEX idx_approvals_status ON approvals(status);

-- migrate:down
DROP INDEX IF EXISTS idx_approvals_status;
DROP INDEX IF EXISTS idx_approvals_project_created;
DROP TABLE IF EXISTS approvals;
