-- =============================================================================
-- 0018_migrations_connections_allowed_hosts · 出站目标显式白名单
--
-- 背景（`.ai-spec/20-security.md` C-4）：出站网络禁止被用作进入内网的通道，
--   因此私网 / 环回 / 链路本地 / 云元数据地址默认全拒。但企业控制台必须能接
--   自建内网系统，于是需要一条**授权路径**——只有"禁止"而没有"授权"时，
--   合法内网接入与恶意内网探测会被同等拒绝。
--
-- 设计：
--   - 白名单**按连接**存储，由平台管理员在前端维护（不是写死在后端代码或全局开关）。
--   - **默认全拒**：列为空数组即维持原有行为，升级本迁移不改变任何现存连接的判定。
--   - 项可为精确主机（`crm.internal`）或后缀通配（`*.internal`）。
--   - 放行不是静默的：命中白名单时由服务层写审计（见 openapi-ingest 的 AuditSink）。
--
-- 为什么不做"允许所有私网"的全局开关：那等于删除 C-4 本身。白名单把授权收敛到
--   "某连接 → 某主机"，可逐条追溯、可逐条撤销。
-- =============================================================================

-- migrate:up
ALTER TABLE system_connections
  ADD COLUMN IF NOT EXISTS allowed_hosts TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN system_connections.allowed_hosts IS
  '出站目标白名单（C-4 授权路径）：默认空数组 = 私网/环回/元数据地址全拒；项可为精确主机或 *. 后缀通配。';

-- migrate:down
ALTER TABLE system_connections DROP COLUMN IF EXISTS allowed_hosts;
