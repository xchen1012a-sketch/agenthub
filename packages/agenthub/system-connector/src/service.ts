/**
 * 系统连接服务（P3 方案书阶段 C T6 / database-schema §3.3）。
 *
 * 0004 `system_connections` 表首次接服务：CRUD + 授权入口路径生成。
 * 所有写操作由服务端身份驱动（created_by 来自入参 userId，模型不可决定）；
 * 读取显式列名（禁 SELECT *）。
 *
 * @module @agenthub/system-connector/service
 */
import { randomUUID } from 'node:crypto'
import {
  AgenthubError,
  createLogger,
  isOutboundTargetAllowed,
  type Logger,
  type Queryable,
} from '@agenthub/_shared'
import {
  AUTH_MODES,
  type CreateConnectionInput,
  type SystemConnection,
  type SystemConnectionRow,
  type UpdateConnectionInput,
} from './types.ts'
import { credentialHeaderNames } from './carrier.ts'
import type { LoginDesk } from './login-session.ts'

/** 平台主站上的登录入口（GET；签发票据后 302 到登录站点）。 */
export function authorizePath(connectionId: string): string {
  return `/agenthub/connections/${connectionId}/authorize`
}

/** 登录站点上一次中转会话的挂载前缀（不带结尾斜杠）。 */
export function proxyPath(connectionId: string, sessionId: string): string {
  return `/agenthub/connections/${connectionId}/s/${sessionId}`
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toConnection(row: SystemConnectionRow): SystemConnection {
  const allowedHosts = row.allowed_hosts
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    frontendUrl: row.frontend_url,
    projectId: row.project_id,
    authMode: row.auth_mode,
    openapiUrl: row.openapi_url,
    hasOpenapiDoc: row.openapi_doc !== null && row.openapi_doc !== undefined,
    credentialHeaders: credentialHeaderNames(row.openapi_doc),
    pendingHosts: pendingHostsOf(row.frontend_url, row.base_url, row.openapi_url, allowedHosts),
    allowedHosts,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

/** 已填写但尚未放行的内网主机。公网主机不出现在这里。 */
export function pendingHostsOf(
  frontendUrl: string,
  baseUrl: string,
  openapiUrl: string | null,
  allowedHosts: readonly string[],
): string[] {
  const hosts: string[] = []
  for (const value of [frontendUrl, baseUrl, openapiUrl]) {
    if (value === null || value === '') continue
    let host: string
    try {
      host = new URL(value).hostname
    } catch {
      continue
    }
    if (!isOutboundTargetAllowed(host, allowedHosts) && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/**
 * 读取列清单（显式；与 toConnection 一一对应；禁 SELECT *）。
 * 以纯字符串常量拼接进语句——列名与 `$n` 占位符均为静态量，无用户数据进入 SQL 文本。
 */
const COLUMNS = 'c.id, c.name, c.base_url, c.frontend_url, c.auth_mode, c.openapi_url, c.openapi_doc, c.allowed_hosts, c.created_by, c.created_at, c.updated_at,'
  + ' (SELECT p.id FROM projects p WHERE p.system_connection_id = c.id LIMIT 1) AS project_id'
const RETURNING = ' RETURNING id, name, base_url, frontend_url, auth_mode, openapi_url, openapi_doc, allowed_hosts, created_by, created_at, updated_at'
const SELECT_COLUMNS = `SELECT ${COLUMNS}`

export class SystemConnectorService {
  private readonly logger: Logger
  private toolReloader: (() => Promise<void>) | null = null
  private desk: LoginDesk | null = null

  constructor(private readonly db: Queryable) {
    this.logger = createLogger('agenthub/system-connector')
  }

  /** 装配侧边浏览器登录（插件按配置的登录站点创建）。 */
  configureLogin(desk: LoginDesk): void {
    this.desk = desk
  }

  /** 登录站点的 `host[:port]`；未配置时为 null。平台主站据此拒绝落在登录站点上的请求。 */
  loginHost(): string | null {
    return this.desk?.loginHost ?? null
  }

  /**
   * 为员工开始一次登录：核验归属与白名单后签发一次性票据，返回登录站点上的入口地址。
   * 员工身份必须来自平台主站的登录态（BND-2）。
   */
  async startLogin(userId: string, roles: readonly string[], connectionId: string): Promise<string> {
    if (this.desk === null) {
      throw new AgenthubError(
        'agenthub/system-connector/LoginOriginMissing',
        '未配置登录中转站点，暂时无法在平台内登录外部系统',
        { httpStatus: 503 },
      )
    }
    const connection = await this.getConnection(connectionId)
    await this.assertProxyAuthorized(userId, roles, connection.id)
    this.assertOperationsAllowed(connection)
    return this.desk.issue(userId, connection.id)
  }

  /**
   * C-5：注入 Tool 重载回调（plugin 装配时指向 `registry.load`；未装配时为 no-op）。
   * 把 Cordis Context 依赖隔离在插件层，service 只持有重载语义。
   */
  setToolReloader(reloader: () => Promise<void>): void {
    this.toolReloader = reloader
  }

  /**
   * C-5：管理台启 / 停 Tool 后调用——按当前 `enabled=true` 重注册（先释放旧注册），
   * 无需重启即生效。未装配重载器时静默返回（如单测 / 无 Cordis 场景）。
   */
  async reloadTools(): Promise<void> {
    if (this.toolReloader === null) return
    await this.toolReloader()
  }

  /**
   * 新建连接。
   *
   * 必填：项目、名称、前端地址、后端地址。认证方式省略时记为 session。
   * 内网地址允许先保存；未放入白名单前，登录 / 解析 / 调用由 assertOperationsAllowed 拒绝。
   */
  async createConnection(input: CreateConnectionInput): Promise<SystemConnection> {
    const projectId = requireNonEmpty(input.projectId, 'projectId')
    const name = requireNonEmpty(input.name, 'name')
    const baseUrl = requireBaseUrl(input.baseUrl)
    const frontendUrl = requireFrontendUrl(input.frontendUrl)
    const authMode = input.authMode === undefined || input.authMode === '' ? 'session' : requireAuthMode(input.authMode)
    const allowedHosts = requireAllowedHosts(input.allowedHosts ?? [])
    const openapiUrl = input.openapiUrl === undefined || input.openapiUrl === null
      ? null
      : requireHttpUrl(input.openapiUrl, 'openapi_url').toString()
    const id = randomUUID()
    const { rows } = await this.db.query<SystemConnectionRow>(
      'INSERT INTO system_connections'
      + ' (id, name, base_url, frontend_url, auth_mode, openapi_url, openapi_doc, allowed_hosts, created_by)'
      + ' VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9)'
      + RETURNING,
      [
        id,
        name,
        baseUrl,
        frontendUrl,
        authMode,
        openapiUrl,
        input.openapiDoc === undefined || input.openapiDoc === null ? null : JSON.stringify(input.openapiDoc),
        allowedHosts,
        input.userId,
      ],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new AgenthubError('agenthub/system-connector/CreateFailed', '系统连接写入未返回行', { httpStatus: 500 })
    }
    const bound = await this.db.query<{ id: string }>(
      'UPDATE projects SET system_connection_id = $1, updated_at = now()'
      + ' WHERE id = $2 AND system_connection_id IS NULL RETURNING id',
      [id, projectId],
    )
    if (bound.rows.length === 0) {
      await this.db.query('DELETE FROM system_connections WHERE id = $1', [id])
      const existing = await this.db.query<{ id: string; system_connection_id: string | null }>(
        'SELECT id, system_connection_id FROM projects WHERE id = $1',
        [projectId],
      )
      if (existing.rows.length === 0) {
        throw new AgenthubError('agenthub/system-connector/ProjectNotFound', '项目不存在', { httpStatus: 404 })
      }
      throw new AgenthubError(
        'agenthub/system-connector/ProjectAlreadyConnected',
        '该项目已经接了一个系统，请修改原连接',
        { httpStatus: 409 },
      )
    }
    row.project_id = projectId
    this.logger.info(
      { event: 'connector.created', projectId, userId: input.userId, traceId: null, sessionId: null },
      { connectionId: id, authMode, allowedHosts },
    )
    return toConnection(row)
  }

  /**
   * 登录、解析文档、调用工具之前调用。
   * 内网主机未放行时拒绝，并在消息里列出主机，指向白名单页。
   */
  assertOperationsAllowed(connection: SystemConnection): void {
    if (connection.projectId === null) {
      throw new AgenthubError(
        'agenthub/system-connector/ConnectionUnassigned',
        '这条连接还没有归入项目，不能登录、解析或调用',
        { httpStatus: 409 },
      )
    }
    const pending = pendingHostsOf(
      connection.frontendUrl,
      connection.baseUrl,
      connection.openapiUrl,
      connection.allowedHosts,
    )
    if (pending.length === 0) return
    throw new AgenthubError(
      'agenthub/system-connector/NotAllowlisted',
      `内网地址尚未放行：${pending.join('、')}。请在该连接的白名单页放入对应主机后再继续`,
      { httpStatus: 409 },
    )
  }

  /** 全部连接（创建时间倒序）。 */
  async listConnections(): Promise<SystemConnection[]> {
    const { rows } = await this.db.query<SystemConnectionRow>(
      SELECT_COLUMNS + ' FROM system_connections c ORDER BY c.created_at DESC',
      [],
    )
    return rows.map(row => toConnection(row))
  }

  /** 单个连接；不存在 → NotFound（404）。 */
  async getConnection(id: string): Promise<SystemConnection> {
    const { rows } = await this.db.query<SystemConnectionRow>(
      SELECT_COLUMNS + ' FROM system_connections c WHERE c.id = $1',
      [id],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new AgenthubError('agenthub/system-connector/ConnectionNotFound', '系统连接不存在', { httpStatus: 404 })
    }
    return toConnection(row)
  }

  /**
   * 局部更新（仅传字段；无字段 → 直接返回现状）。
   *
   * 白名单与文档地址相互约束：改任一方都要对**生效后的组合**重新校验，
   * 否则"先存受限 URL → 再撤白名单"会留下一个拉取时才炸的连接。
   */
  async updateConnection(id: string, patch: UpdateConnectionInput): Promise<SystemConnection> {
    const sets: string[] = []
    const params: unknown[] = [id]

    const nextAllowed = patch.allowedHosts === undefined ? null : requireAllowedHosts(patch.allowedHosts)
    const nextOpenapiUrl = patch.openapiUrl === undefined
      ? undefined
      : patch.openapiUrl === null ? null : requireHttpUrl(patch.openapiUrl, 'openapi_url').toString()
    const nextBase = patch.baseUrl === undefined ? undefined : requireBaseUrl(patch.baseUrl)
    const nextFrontend = patch.frontendUrl === undefined ? undefined : requireFrontendUrl(patch.frontendUrl)
    const nextAuth = patch.authMode === undefined ? undefined : requireAuthMode(patch.authMode)

    if (patch.name !== undefined) {
      params.push(requireNonEmpty(patch.name, 'name'))
      sets.push(`name = $${params.length}`)
    }
    if (nextBase !== undefined) {
      params.push(nextBase)
      sets.push(`base_url = $${params.length}`)
    }
    if (nextFrontend !== undefined) {
      params.push(nextFrontend)
      sets.push(`frontend_url = $${params.length}`)
    }
    if (nextAuth !== undefined) {
      params.push(nextAuth)
      sets.push(`auth_mode = $${params.length}`)
    }
    if (nextOpenapiUrl !== undefined) {
      params.push(nextOpenapiUrl)
      sets.push(`openapi_url = $${params.length}`)
    }
    if (patch.openapiDoc !== undefined) {
      params.push(patch.openapiDoc === null ? null : JSON.stringify(patch.openapiDoc))
      sets.push(`openapi_doc = $${params.length}::jsonb`)
    }
    if (nextAllowed !== null) {
      params.push(nextAllowed)
      sets.push(`allowed_hosts = $${params.length}::text[]`)
    }
    const addressChanged = nextBase !== undefined || nextFrontend !== undefined
    if (addressChanged && nextAuth === undefined) {
      params.push('session')
      sets.push(`auth_mode = $${params.length}`)
    }
    if (sets.length === 0) return await this.getConnection(id)
    const { rows } = await this.db.query<{ id: string }>(
      'UPDATE system_connections SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1 RETURNING id',
      params,
    )
    if (rows.length === 0) {
      throw new AgenthubError('agenthub/system-connector/ConnectionNotFound', '系统连接不存在', { httpStatus: 404 })
    }
    if (addressChanged) {
      await this.db.query(
        'UPDATE tools SET enabled = false, updated_at = now() WHERE system_connection_id = $1',
        [id],
      )
      await this.db.query('DELETE FROM user_credentials WHERE system_connection_id = $1', [id])
    }
    return await this.getConnection(id)
  }

  /**
   * 删除连接（物理删；tools.system_connection_id 由 FK ON DELETE SET NULL 置空）。
   *
   * ⚠️ 与 UI 的"删除"按钮不是同一条路径：按钮走的是软删（`deleted_at`），
   * 本方法保留给确实要清行的运维场景。
   */
  async deleteConnection(id: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      'DELETE FROM system_connections WHERE id = $1 RETURNING id',
      [id],
    )
    const deleted = rows.length > 0
    this.logger.info(
      { event: 'connector.deleted', projectId: null, userId: null, traceId: null, sessionId: null },
      { connectionId: id, deleted },
    )
    return deleted
  }

  /**
   * C-2 反代门禁：调用者必须是该 connection 所属 Project（`projects.system_connection_id`）
   * 的成员（`project_members` + 账号 active），或平台管理员；否则 403（fail-closed）。
   * 未关联任何 Project 的连接对非管理员一律拒绝（不允许匿名跳板）。
   */
  async assertProxyAuthorized(userId: string, roles: readonly string[], connectionId: string): Promise<void> {
    if (roles.includes('platform_admin')) return
    const { rows } = await this.db.query<{ ok: number }>(
      'SELECT 1 AS ok FROM projects p'
      + ' JOIN project_members pm ON pm.project_id = p.id'
      + " JOIN users u ON u.id = pm.user_id AND u.status = 'active'"
      + ' WHERE p.system_connection_id = $1 AND pm.user_id = $2 LIMIT 1',
      [connectionId, userId],
    )
    if (rows.length === 0) {
      throw new AgenthubError(
        'agenthub/system-connector/ProxyForbidden',
        '你不是该连接所属 Project 的成员，拒绝反代',
        { httpStatus: 403 },
      )
    }
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new AgenthubError('agenthub/system-connector/InvalidConnection', `系统连接字段 ${field} 必填`, { httpStatus: 422 })
  }
  return trimmed
}

function requireBaseUrl(value: string): string {
  return requireHttpUrl(value, 'base_url').origin
}

/** 前端地址保留路径，去掉查询串。登录页经常不在站点根上。 */
function requireFrontendUrl(value: string): string {
  const url = requireHttpUrl(value, 'frontend_url')
  url.search = ''
  url.hash = ''
  return url.toString()
}

function requireHttpUrl(value: string, field: 'base_url' | 'frontend_url' | 'openapi_url'): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    const code = field === 'openapi_url'
      ? 'agenthub/system-connector/InvalidOpenApiUrl'
      : field === 'frontend_url'
        ? 'agenthub/system-connector/InvalidFrontendUrl'
        : 'agenthub/system-connector/InvalidBaseUrl'
    throw new AgenthubError(code, `${field} 必须是合法 URL`, { httpStatus: 422 })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const code = field === 'openapi_url'
      ? 'agenthub/system-connector/InvalidOpenApiUrl'
      : field === 'frontend_url'
        ? 'agenthub/system-connector/InvalidFrontendUrl'
        : 'agenthub/system-connector/InvalidBaseUrl'
    throw new AgenthubError(code, `${field} 仅支持 http/https`, { httpStatus: 422 })
  }
  return url
}

function requireAuthMode(value: string): string {
  if (!(AUTH_MODES as readonly string[]).includes(value)) {
    throw new AgenthubError(
      'agenthub/system-connector/InvalidAuthMode',
      `auth_mode 必须是 ${AUTH_MODES.join(' / ')} 之一`,
      { httpStatus: 422 },
    )
  }
  return value
}


/**
 * 把一条白名单输入归一化成主机名。
 *
 * 用户最可能粘**整个网址**而不是主机名（"要接的系统是 http://localhost:48080"），
 * 因此这里直接接受网址并取出其 hostname——报错让人自己删路径/端口是没必要的摩擦。
 * @param raw - 原始输入项。
 * @returns 主机名；无法解析时返回 `null`（由调用方报错）。
 */
function normalizeAllowedHost(raw: string): string | null {
  const entry = raw.trim().toLowerCase()
  if (entry === '') return null
  if (entry.includes('://')) {
    try {
      return new URL(entry).hostname.replace(/^\[|\]$/g, '')
    } catch {
      return null
    }
  }
  const bare = entry.startsWith('*.') ? entry.slice(2) : entry
  if (bare === '' || /[/:@\s]/.test(bare)) return null
  return entry
}

/**
 * 校验白名单项并归一化。
 *
 * 只做形状校验（非空、无协议 / 路径 / 端口 / 通配以外的字符），**不做**"必须是受限地址"
 * 之类的业务判断——白名单的语义是"允许"，写多了无害，写错了由下一次拉取暴露。
 * @param values - 前端提交的白名单项（允许是网址，会被取出主机名）。
 * @returns 去空白、去重后的主机项。
 * @throws AgenthubError 某一项无法解析为主机名（422）。
 */
function requireAllowedHosts(values: readonly string[]): string[] {
  const cleaned: string[] = []
  for (const raw of values) {
    const host = normalizeAllowedHost(raw)
    if (host === null) {
      throw new AgenthubError(
        'agenthub/system-connector/InvalidAllowedHost',
        `白名单项无法解析为主机名：${raw}（请填主机名如 localhost，或 *.internal 这样的通配；填网址也可以，会自动取主机名）`,
        { httpStatus: 422 },
      )
    }
    cleaned.push(host)
  }
  return [...new Set(cleaned)]
}
