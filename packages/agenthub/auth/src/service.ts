/**
 * 平台身份服务（.ai-spec 20-security.md SEC-4 完整链路：Argon2id + sessions 表 + Cookie）。
 *
 * dev 匿名（AGENTHUB_AUTH_DEV_ANON !== 'false'）保留为开发后门；显式关闭时
 * 走真登录，缺 AGENTHUB_COOKIE_SECRET 即启动失败（fail-closed）。
 *
 * @module @agenthub/auth/service
 */
import type { IncomingMessage } from 'node:http'
import { AgenthubError, asUserId, createLogger, type Logger, type UserId } from '@agenthub/_shared'
import type { Queryable } from '@agenthub/_shared'
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  parseCookies,
  sessionSetCookie,
  verifiedSessionId,
} from './cookies.ts'
import { hashPassword, verifyPassword } from './password.ts'

/** 平台用户视角（roles 取值同 roles.name：platform_admin / project_admin / member / approver）。 */
export interface AuthUser {
  readonly userId: UserId
  readonly displayName: string
  readonly roles: readonly string[]
}

/** 请求级身份：user + 已解析的登录会话（dev 匿名时 sessionId 为 null）。 */
export interface AuthIdentity extends AuthUser {
  readonly sessionId: string | null
}

/** dev 匿名用户固定 ID（users 表内真实行，projects.created_by 外键引用它）。 */
export const DEV_USER_ID = asUserId('00000000-0000-4000-8000-000000000001')

/** dev 匿名开关（.env.example：AGENTHUB_AUTH_DEV_ANON）；显式 'false' 即关闭。 */
export function devAnonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AGENTHUB_AUTH_DEV_ANON !== 'false'
}

/** 登录成功结果：sessionId 供路由层下发 Cookie。 */
export interface SignInResult {
  readonly user: AuthUser
  readonly sessionId: string
}

/** 注册输入（schema 由 ui 路由层校验格式，本层只做语义校验）。 */
export interface SignUpInput {
  readonly email: string
  readonly displayName: string
  readonly password: string
}

export interface SignInInput {
  readonly email: string
  readonly password: string
}

/** 登录成功回调（plugin 注入 ctx.emit('agenthub/user.authenticated')）。 */
export type AuthenticatedListener = (payload: { userId: string; sessionId: string }) => void

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function unauthorized(): AgenthubError {
  return new AgenthubError('agenthub/auth/Unauthenticated', '未登录或登录已过期', { httpStatus: 401 })
}

export class AuthService {
  private readonly logger: Logger
  private readonly env: Record<string, string | undefined>
  /** Cookie 签名密钥；dev 匿名模式下可为 null（不发 Cookie）。 */
  private readonly secret: string | null
  /** dev 用户行 upsert 的进程内一次性守卫。 */
  private devUserReady: Promise<void> | null = null

  constructor(
    private readonly options: {
      db: Queryable
      env?: Record<string, string | undefined>
      logger?: Logger
      onAuthenticated?: AuthenticatedListener
    },
  ) {
    this.logger = options.logger ?? createLogger('agenthub/auth')
    this.env = options.env ?? process.env
    this.secret = this.resolveSecret()
  }

  /** 是否允许 dev 匿名兜底身份。 */
  get devAnon(): boolean {
    return devAnonEnabled(this.env)
  }

  /** 解析当前请求身份（.ai-spec 20-security.md BND-2：只来自服务端登录态，模型永不可传入）。 */
  async resolveIdentity(req: IncomingMessage): Promise<AuthIdentity> {
    if (this.devAnon) return await this.devIdentity()
    const jar = parseCookies(req.headers.cookie)
    const sessionId = this.secret === null ? null : verifiedSessionId(this.secret, jar)
    if (sessionId === null || !UUID_RE.test(sessionId)) throw unauthorized()
    return this.resolveSessionUser(sessionId)
  }

  /** 注册（默认 member 角色）；email 冲突 409。 */
  async signUp(input: SignUpInput): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim()
    if (email === '' || displayName === '' || input.password.length < 8) {
      throw new AgenthubError(
        'agenthub/auth/InvalidSignUp',
        '邮箱、显示名不能为空，密码至少 8 位',
        { httpStatus: 400 },
      )
    }
    const passwordHash = await hashPassword(input.password)
    try {
      const inserted = await this.options.db.query<{ id: string }>(
        'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [email, displayName, passwordHash],
      )
      const userId = inserted.rows[0]?.id
      if (userId === undefined) throw unauthorized()
      await this.assignRole(userId, 'member')
      return { userId: asUserId(userId), displayName, roles: ['member'] }
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AgenthubError('agenthub/auth/EmailExists', '该邮箱已注册', { httpStatus: 409 })
      }
      throw error
    }
  }

  /** 登录：Argon2id 校验 → 写 sessions 表（TTL 24h）→ 发 user.authenticated。 */
  async signIn(input: SignInInput, traceId: string | null): Promise<SignInResult> {
    const found = await this.options.db.query<{
      id: string
      display_name: string
      password_hash: string
      status: string
    }>(
      'SELECT id, display_name, password_hash, status FROM users WHERE email = $1',
      [input.email.trim().toLowerCase()],
    )
    const row = found.rows[0]
    // 统一失败语义：不泄露「账号不存在 / 密码错误」差异。
    if (row === undefined || row.status !== 'active' || !(await verifyPassword(row.password_hash, input.password))) {
      throw new AgenthubError('agenthub/auth/InvalidCredential', '邮箱或密码不正确', {
        httpStatus: 401,
      })
    }
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    const created = await this.options.db.query<{ id: string }>(
      'INSERT INTO sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id',
      [row.id, expiresAt],
    )
    const sessionId = created.rows[0]?.id
    if (sessionId === undefined) {
      throw new AgenthubError('agenthub/auth/SessionCreateFailed', '登录会话创建失败')
    }
    const roles = await this.loadRoles(row.id)
    const user: AuthUser = { userId: asUserId(row.id), displayName: row.display_name, roles }
    this.options.onAuthenticated?.({ userId: row.id, sessionId })
    this.logger.info(
      { event: 'user.authenticated', projectId: null, userId: user.userId, traceId, sessionId },
      { mode: 'password' },
    )
    return { user, sessionId }
  }

  /** 登出：删除会话行（Cookie 清理由路由层完成）。 */
  async signOut(req: IncomingMessage): Promise<void> {
    if (this.secret === null) return
    const sessionId = verifiedSessionId(this.secret, parseCookies(req.headers.cookie))
    if (sessionId === null) return
    await this.options.db.query('DELETE FROM sessions WHERE id = $1', [sessionId])
  }

  /** 生成登录态 Set-Cookie 值（登录成功后由路由层下发；dev 匿名模式无密钥，503）。 */
  sessionCookie(sessionId: string): string {
    if (this.secret === null) {
      throw new AgenthubError(
        'agenthub/auth/CookieSecretMissing',
        'dev 匿名模式未配置 AGENTHUB_COOKIE_SECRET，无法签发会话 Cookie',
        { httpStatus: 503 },
      )
    }
    return sessionSetCookie(this.secret, sessionId)
  }

  /** 清除登录态 Set-Cookie 值（登出用）。 */
  get sessionClearCookie(): string {
    return clearSessionCookie()
  }

  private async resolveSessionUser(sessionId: string): Promise<AuthIdentity> {
    const found = await this.options.db.query<{
      user_id: string
      display_name: string
      status: string
      expires_at: Date
    }>(
      `SELECT s.user_id, u.display_name, u.status, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [sessionId],
    )
    const row = found.rows[0]
    if (row === undefined || row.expires_at.getTime() <= Date.now()) {
      await this.options.db.query('DELETE FROM sessions WHERE id = $1', [sessionId])
      throw unauthorized()
    }
    if (row.status !== 'active') {
      throw new AgenthubError('agenthub/auth/AccountDisabled', '账号已被禁用', { httpStatus: 403 })
    }
    // 滑动续期：每次成功访问重置 TTL（阶段书 P2）。
    await this.options.db.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [
      sessionId,
      new Date(Date.now() + SESSION_TTL_MS),
    ])
    const roles = await this.loadRoles(row.user_id)
    return {
      userId: asUserId(row.user_id),
      displayName: row.display_name,
      roles,
      sessionId,
    }
  }

  private async loadRoles(userId: string): Promise<string[]> {
    const found = await this.options.db.query<{ name: string }>(
      'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
      [userId],
    )
    return found.rows.map(r => r.name)
  }

  private async assignRole(userId: string, roleName: string): Promise<void> {
    await this.options.db.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name = $2
       ON CONFLICT DO NOTHING`,
      [userId, roleName],
    )
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    )
  }

  /** dev 匿名身份（进程内幂等 upsert 用户行：projects.created_by 外键要求行真实存在）。 */
  private async devIdentity(): Promise<AuthIdentity> {
    this.devUserReady ??= this.ensureDevUser()
    await this.devUserReady
    return { userId: DEV_USER_ID, displayName: 'Dev Admin', roles: ['platform_admin'], sessionId: null }
  }

  private async ensureDevUser(): Promise<void> {
    await this.options.db.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_USER_ID, 'dev@agenthub.local', 'Dev Admin', 'dev-anon-placeholder'],
    )
  }

  private resolveSecret(): string | null {
    const secret = this.env.AGENTHUB_COOKIE_SECRET
    if (this.devAnon && (secret === undefined || secret === '')) return null
    if (secret === undefined || secret.length < 32) {
      throw new AgenthubError(
        'agenthub/auth/CookieSecretMissing',
        'AGENTHUB_COOKIE_SECRET 未设置或不足 32 字符；真登录模式下必填（.ai-spec 20-security.md SEC-7）',
      )
    }
    return secret
  }
}
