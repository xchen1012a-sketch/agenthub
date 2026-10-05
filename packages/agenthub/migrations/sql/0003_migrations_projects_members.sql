-- =============================================================================
-- 0003_migrations_projects_members · Project 与成员
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.2
--   - projects / project_members
--   - harness_workspace_id UNIQUE（V7 验收项；P1 内存版写入 "mem:<uuid>"，
--     P2 真接 Harness Workspace 后回写真实 ID）
--   - system_connection_id 列在此建出，FK 约束推迟到 0004
--     （system_connections 表在 0004 才存在）
--   - created_by 不加 ON DELETE（NO ACTION）：删除被引用用户将失败，
--     fail-closed，避免企业 Project 资产被静默级联删除
-- =============================================================================

-- migrate:up
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  system_connection_id UUID,
  harness_workspace_id TEXT NOT NULL UNIQUE,
  default_agent_id UUID,
  memory_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'approver')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- 外键字段建索引（.ai-spec 30-data.md DATA-3 SHOULD）
CREATE INDEX idx_projects_created_by ON projects(created_by);
CREATE INDEX idx_project_members_user_id ON project_members(user_id);

-- migrate:down
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS projects;
