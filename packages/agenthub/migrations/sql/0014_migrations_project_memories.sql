-- =============================================================================
-- 0014_migrations_project_memories · 项目记忆（P4 方案书阶段 A T1）
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.6
--   - embedding VECTOR(1536)：维度与 embedding 模型一致（secrets.md §1.2）
--   - metadata JSONB：约定 { created_by_session_id, locked, tags, deleted, status }
--   - locked BOOLEAN 默认 false；软删走 metadata.deleted（不清表，§3.6 SHOULD）
--   - 向量索引 ivfflat (embedding vector_cosine_ops) lists=100（§3.6 SHOULD 中小规模）
--   - project_id 为业务表外键 → ON DELETE CASCADE（§4）
-- =============================================================================

-- migrate:up
CREATE TABLE project_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  locked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_memories_embedding
  ON project_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- migrate:down
DROP INDEX IF EXISTS idx_project_memories_embedding;
DROP TABLE IF EXISTS project_memories;