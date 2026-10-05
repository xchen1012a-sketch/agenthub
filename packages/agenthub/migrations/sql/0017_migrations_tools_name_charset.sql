-- =============================================================================
-- 0017_migrations_tools_name_charset · 内置示例工具名改为协议允许的字符集
--
-- 规范：deepseek-harness/.ai-spec/30-data.md DATA-1（迁移命名与排序）
--
-- 背景：工具名每次请求都作为 `tools[].function.name` 发给模型服务，函数调用协议
--   只接受 `^[A-Za-z0-9_-]{1,128}$`。0007 种下的三个示例工具名含点号（`.`），
--   会被模型服务在入口拒绝整个请求（HTTP 400），且报错指向 provider，
--   使排障方向误入"凭证/模型配置错误"。
--
--   点号在 DeepSeek 与火山方舟上**同样被拒**（实测），因此这是协议约束而非
--   某一家的限制；改名后与 0016 之后导入侧 `normalizeToolName` 的产物一致。
--
-- 不改写 0007：迁移是已发布的历史，只能追加后继迁移。
-- 该 UPDATE 幂等：目标名不存在时影响 0 行。
-- =============================================================================

-- migrate:up
UPDATE tools SET name = 'echo_read' WHERE name = 'echo.read';
UPDATE tools SET name = 'noop_write' WHERE name = 'noop.write';
UPDATE tools SET name = 'noop_sensitive' WHERE name = 'noop.sensitive';

-- migrate:down
UPDATE tools SET name = 'echo.read' WHERE name = 'echo_read';
UPDATE tools SET name = 'noop.write' WHERE name = 'noop_write';
UPDATE tools SET name = 'noop.sensitive' WHERE name = 'noop_sensitive';
