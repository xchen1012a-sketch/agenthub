/**
 * 侧边浏览器登录的票据与中转会话（进程内，不落库）。
 *
 * 平台主站按当前登录态签发一次性票据；登录站点用票据换出中转会话。侧边浏览器
 * 里的页面与平台主站不同站，Cookie 带不进去，所以中转会话只认路径里的标识。
 * 会话里不保存凭证明文：Cookie 罐是外部系统下发给这名员工的会话，只用于继续
 * 转发；已保存凭证只留摘要，用来判断是否需要再存一次。
 *
 * @module @agenthub/system-connector/login-session
 */
import { randomBytes } from 'node:crypto'
import { AgenthubError } from '@agenthub/_shared'

/** 票据从签发到使用的最长间隔。 */
const TICKET_TTL_MS = 2 * 60 * 1000
/** 中转会话的空闲上限；每次请求顺延。 */
const SESSION_TTL_MS = 30 * 60 * 1000
const TOKEN_BYTES = 32

/** 一名员工在一条连接上的中转会话。 */
export interface LoginSession {
  readonly id: string
  readonly userId: string
  readonly connectionId: string
  /** 外部系统经中转下发的 Cookie（名 → 值）。 */
  readonly cookies: Map<string, string>
  /** 最近一次保存的凭证摘要；相同则不重复保存。 */
  savedDigest: string | null
  /** 已从请求头取到凭证后，Cookie 不再覆盖它。 */
  headerCaptured: boolean
  expiresAt: number
}

interface Ticket {
  readonly userId: string
  readonly connectionId: string
  readonly expiresAt: number
}

export interface LoginDeskOptions {
  /** 登录站点源（与平台主站不同站）。未配置时登录入口不可用。 */
  readonly origin: string | null
  readonly now?: () => number
  readonly token?: () => string
}

export class LoginDesk {
  private readonly origin: URL | null
  private readonly now: () => number
  private readonly token: () => string
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, LoginSession>()

  constructor(options: LoginDeskOptions) {
    this.origin = options.origin === null ? null : parseOrigin(options.origin)
    this.now = options.now ?? Date.now
    this.token = options.token ?? (() => randomBytes(TOKEN_BYTES).toString('base64url'))
  }

  /** 登录站点的 `host[:port]`；未配置时为 null。 */
  get loginHost(): string | null {
    return this.origin?.host ?? null
  }

  /** 请求是否落在登录站点上（按 Host 头判定）。 */
  isLoginHost(host: string | undefined): boolean {
    return this.origin !== null && host !== undefined && host.toLowerCase() === this.origin.host
  }

  /** 签发票据并返回登录站点上的入口地址。调用方须已核验员工与连接的归属。 */
  issue(userId: string, connectionId: string): string {
    if (this.origin === null) {
      throw new AgenthubError(
        'agenthub/system-connector/LoginOriginMissing',
        '未配置登录中转站点，暂时无法在平台内登录外部系统',
        { httpStatus: 503 },
      )
    }
    this.prune()
    const ticket = this.token()
    this.tickets.set(ticket, { userId, connectionId, expiresAt: this.now() + TICKET_TTL_MS })
    const entry = new URL(`/agenthub/connections/${encodeURIComponent(connectionId)}/enter`, this.origin)
    entry.searchParams.set('ticket', ticket)
    return entry.toString()
  }

  /** 用票据换中转会话。票据只能用一次，且只对签发时的连接有效。 */
  enter(ticket: string, connectionId: string): LoginSession | null {
    this.prune()
    const found = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (found === undefined || found.connectionId !== connectionId || found.expiresAt <= this.now()) return null
    const session: LoginSession = {
      id: this.token(),
      userId: found.userId,
      connectionId,
      cookies: new Map(),
      savedDigest: null,
      headerCaptured: false,
      expiresAt: this.now() + SESSION_TTL_MS,
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** 取中转会话并顺延；过期、不存在或连接不符时返回 null。 */
  session(id: string, connectionId: string): LoginSession | null {
    const found = this.sessions.get(id)
    if (found === undefined) return null
    if (found.expiresAt <= this.now()) {
      this.sessions.delete(id)
      return null
    }
    if (found.connectionId !== connectionId) return null
    found.expiresAt = this.now() + SESSION_TTL_MS
    return found
  }

  private prune(): void {
    const now = this.now()
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(key)
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key)
  }
}

function parseOrigin(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgenthubError('agenthub/system-connector/InvalidLoginOrigin', `登录中转站点不是合法地址：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgenthubError('agenthub/system-connector/InvalidLoginOrigin', '登录中转站点仅支持 http/https')
  }
  return new URL(url.origin)
}
