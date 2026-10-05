/**
 * 会话 Cookie 与 CSRF 双提交令牌（.ai-spec 20-security.md SEC-4：HttpOnly / SameSite=Lax / 24h）。
 *
 * Cookie 值为 `<sessionId>.<hmac>`：签名防篡改，DB 中只存裸 UUID。
 *
 * @module @agenthub/auth/cookies
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 登录态 Cookie（HttpOnly）。 */
export const SESSION_COOKIE = 'agenthub_session'
/** CSRF 双提交 Cookie（非 HttpOnly，前端可读并以表单字段回传）。 */
export const CSRF_COOKIE = 'agenthub_csrf'
/** 会话 TTL：24h，滑动续期（阶段书 P2）。 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** 解析 Cookie 请求头为键值表（重复名取首个）。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {}
  if (header === undefined || header === '') return jar
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key !== '' && jar[key] === undefined) jar[key] = decodeURIComponent(value)
  }
  return jar
}

function hmac(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url')
}

/** 生成带签名的 Set-Cookie 值（HttpOnly 登录态）。 */
export function sessionSetCookie(secret: string, sessionId: string): string {
  const value = `${sessionId}.${hmac(secret, sessionId)}`
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
}

/** 清除登录态 Cookie（登出）。 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** 从 Cookie 表解析并校验签名，返回裸 sessionId；非法/被篡改返回 null。 */
export function verifiedSessionId(secret: string, jar: Record<string, string>): string | null {
  const raw = jar[SESSION_COOKIE]
  if (raw === undefined) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const sessionId = raw.slice(0, dot)
  const expected = hmac(secret, sessionId)
  const actual = raw.slice(dot + 1)
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return sessionId
}

/** 生成 CSRF 令牌（32 字节 hex）。 */
export function createCsrfToken(): string {
  return randomBytes(32).toString('hex')
}

/** 生成 CSRF 双提交 Cookie（非 HttpOnly）。 */
export function csrfSetCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax`
}

/**
 * 校验写请求 CSRF（.ai-spec 20-security.md SEC-5 双提交）：提交令牌（表单字段 `_csrf` 或
 * `X-CSRF-Token` 头）必须与 Cookie 中的令牌一致。
 */
export function verifyCsrf(
  jar: Record<string, string>,
  submitted: string | null | undefined,
): boolean {
  const cookieToken = jar[CSRF_COOKIE]
  if (cookieToken === undefined || cookieToken === '' || submitted === null || submitted === undefined || submitted === '') {
    return false
  }
  const a = Buffer.from(cookieToken)
  const b = Buffer.from(submitted)
  return a.length === b.length && timingSafeEqual(a, b)
}
