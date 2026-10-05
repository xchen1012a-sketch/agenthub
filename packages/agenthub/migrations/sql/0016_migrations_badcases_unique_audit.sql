-- =============================================================================
-- 0016_migrations_badcases_unique_audit · 一条审计记录最多一个坏例判定
--
-- 规范：deepseek-harness/.ai-spec/30-data.md DATA-1（迁移命名与排序）
--   - 坏例是"对一次调用的判定"，一条审计记录只能有一个判定；重复登记必须
--     更新既有行，而不是堆积多行各自 resolved，否则列表与统计会出现同一调用
--     多个互相矛盾的结论。
--   - 该唯一约束是幂等登记（badcases ON CONFLICT (audit_id) DO UPDATE）的前提。
--   - 建约束前先收敛历史重复行（本约束加入前可能有重复），否则迁移失败。
-- =============================================================================

-- migrate:up
DELETE FROM badcases a
  USING badcases b
  WHERE a.audit_id = b.audit_id
    AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

ALTER TABLE badcases ADD CONSTRAINT badcases_audit_id_key UNIQUE (audit_id);

-- migrate:down
ALTER TABLE badcases DROP CONSTRAINT IF EXISTS badcases_audit_id_key;
