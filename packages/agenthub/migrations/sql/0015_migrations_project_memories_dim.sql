-- =============================================================================
-- 0015_migrations_project_memories_dim.sql · 向量改用 halfvec(2048)
--
-- 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-1.6
--
-- 背景（P4 阶段 B D35 实测）：
--   - embedding 模型确定为火山方舟 `doubao-embedding-vision`（接入点
--     `/api/coding/v3/embeddings`），**输出恒为 2048 维**且不支持 `dimensions` 参数；
--   - pgvector 0.8.6 的 **`vector` 类型索引硬上限是 2000 维**（ivfflat / hnsw 同限），
--     实测 `CREATE INDEX ... USING ivfflat (embedding vector_cosine_ops)` 报
--     `column cannot have more than 2000 dimensions for ivfflat index`。
--
-- 因此列类型从 `vector(1536)` 改为 **`halfvec(2048)`**：
--   - halfvec 存半精度（每维 2 字节），索引上限 4000 维，实测 HNSW 建索引与
--     `<=>` 余弦排序均正常；
--   - halfvec 半精度（10 位尾数）远高于 embedding 本身的有效精度，属"保留全部维度、
--     不截断、不降维"的方案；对比「截断到 1536 维」不丢失任何语义维度。
--
-- 表在 0014 建出后尚无数据（阶段 A 未接提取链路），故用「删列 + 重建列 + 重建索引」；
-- pgvector 不支持修改 vector 列的类型 / 维度。若未来在有数据时再变维度，必须改为
-- 「新列 + 向量重算 + 切列」的在线迁移，不得沿用本写法。
-- =============================================================================

-- migrate:up
ALTER TABLE project_memories DROP COLUMN embedding;
ALTER TABLE project_memories ADD COLUMN embedding halfvec(2048) NOT NULL;

DROP INDEX IF EXISTS idx_project_memories_embedding;
-- 2048 维无法用 ivfflat（>2000 上限），改用 HNSW（database-schema §3.6 对大规模的建议形态）。
CREATE INDEX idx_project_memories_embedding
  ON project_memories USING hnsw (embedding halfvec_cosine_ops);

-- migrate:down
ALTER TABLE project_memories DROP COLUMN embedding;
ALTER TABLE project_memories ADD COLUMN embedding vector(1536) NOT NULL;

DROP INDEX IF EXISTS idx_project_memories_embedding;
CREATE INDEX idx_project_memories_embedding
  ON project_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
