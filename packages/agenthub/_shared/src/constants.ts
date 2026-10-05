/**
 * 脱敏字段名清单（.ai-spec 20-security.md SEC-1 的 SHOULD 落点：黑 / 白名单集合收口在本文件）。
 *
 * 只做字段名匹配，禁止正则内容扫描（.ai-spec 20-security.md SEC-1 MUST：
 * 正则可被编码 / 嵌套 / 分片绕过；字段名清单是确定性匹配）。
 *
 * - `SENSITIVE_FIELDS` / `SENSITIVE_SUFFIXES`：日志 / 事件用黑名单（`redact`，原语义不变）；
 * - `AUDIT_DENIED_FIELDS` / `AUDIT_ALLOWED_FIELDS`：`audit_records.args` / `approvals.args`
 *   落库用「白名单 + 黑名单」双重过滤（`redactArgs`）。
 *
 * @module @agenthub/_shared/constants
 */

/** 敏感字段名精确集（小写、`-` 归一为 `_` 后比对）。 */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'password_hash',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'api_key',
  'apikey',
  'apikeys',
  'secret_key',
  'secret_access_key',
  'private_key',
  'client_secret',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'master_key',
  'kek',
  'agenthub_vault_master_key',
])

/**
 * 后缀规则：归一后的键名以这些后缀结尾即视为敏感
 * （覆盖 access_token / user_token / clientSecret / X-Api-Key 等复合命名；
 * 过杀方向安全——多脱敏不漏脱敏）。
 */
export const SENSITIVE_SUFFIXES: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'signature',
  '_key',
]

/**
 * 审计 args 落库黑名单（.ai-spec 20-security.md SEC-1 的 SSOT 命名）：命中即整体置 `***`，
 * 优先于白名单（兜底——即使某键同时出现在白名单，也按黑名单处理）。
 * 与 SENSITIVE_FIELDS 同源，避免两处清单漂移。
 */
export const AUDIT_DENIED_FIELDS: ReadonlySet<string> = SENSITIVE_FIELDS

/**
 * 审计 args 落库白名单（.ai-spec 20-security.md SEC-1 / §1.4 MUST：字段名白名单 + 黑名单双过滤，
 * 禁止正则）。`redactArgs` 只保留本集合内的键，其余键一律丢弃（默认拒绝）。
 * 收录范围限定为检索 / 定位 / 分页 / 时间窗等非敏感操作参数（小写、`-` 归一为 `_` 后比对）。
 */
export const AUDIT_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  // 检索与关键词
  'query',
  'q',
  'keyword',
  'keywords',
  'search',
  // 路径与方法
  'path',
  'url',
  'endpoint',
  'method',
  'http_method',
  // 实体标识（非凭证）
  'id',
  'ids',
  'name',
  'title',
  'type',
  'status',
  'category',
  // 分页与排序
  'page',
  'page_size',
  'pagesize',
  'limit',
  'offset',
  'count',
  'sort',
  'order',
  'fields',
  'format',
  // 过滤条件与时间窗
  'filter',
  'filters',
  'from',
  'to',
  'start',
  'end',
  'start_time',
  'end_time',
  'date',
  'since',
  'until',
  // 本地化（非敏感）
  'language',
  'locale',
  'timezone',
  // 关联标识
  'project_id',
  'tool_id',
  'session_id',
  'system_connection_id',
])
