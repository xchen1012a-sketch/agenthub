-- =============================================================================
-- 0007_migrations_tools · Tool Registry 与 Project Tool Set
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.4
--   - tools / project_tool_set；种子 3 个手动示例 Tool（echo.read / noop.write /
--     noop.sensitive），noop.sensitive 参数含敏感字段名用于 V5 脱敏验证
--   - created_by 允许 NULL：种子 Tool 无创建者；人工创建时由应用层写入
--   - system_connection_id 引用 0004 的 system_connections，ON DELETE SET NULL
--     （连接删除不连带删除 Tool 定义；业务语义归 enabled=false）
-- =============================================================================

-- migrate:up
CREATE TABLE tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL CHECK (source IN ('openapi', 'mcp', 'manual')),
  source_ref TEXT,
  system_connection_id UUID REFERENCES system_connections(id) ON DELETE SET NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('read', 'write', 'sensitive', 'critical')),
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_tool_set (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  configured_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, tool_id)
);

-- 外键字段建索引（.ai-spec 30-data.md DATA-3 SHOULD）
CREATE INDEX idx_tools_system_connection_id ON tools(system_connection_id);
CREATE INDEX idx_project_tool_set_tool_id ON project_tool_set(tool_id);

-- 种子：3 个手动示例 Tool（幂等；enabled 默认开，供 P2 隔离验证）
INSERT INTO tools (name, description, parameters, source, risk_level, enabled) VALUES
  (
    'echo.read',
    '原样返回输入参数的只读示例工具',
    '{"type":"object","properties":{"message":{"type":"string","description":"要回显的文本"}},"required":["message"]}'::jsonb,
    'manual',
    'read',
    true
  ),
  (
    'noop.write',
    '无副作用的写入示例工具（P2 无审批流，requires_approval 留待 P3 启用）',
    '{"type":"object","properties":{"target":{"type":"string","description":"模拟写入目标"}},"required":["target"]}'::jsonb,
    'manual',
    'write',
    true
  ),
  (
    'noop.sensitive',
    '参数含敏感字段名的示例工具，用于验证审计脱敏（V5）',
    '{"type":"object","properties":{"query":{"type":"string","description":"查询内容"},"token":{"type":"string","description":"将被脱敏的字段"},"password":{"type":"string","description":"将被脱敏的字段"},"secret":{"type":"string","description":"将被脱敏的字段"}},"required":["query"]}'::jsonb,
    'manual',
    'sensitive',
    true
  )
ON CONFLICT (name) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS project_tool_set;
DROP TABLE IF EXISTS tools;
