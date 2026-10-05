/**
 * @agenthub/auth —— 平台身份（Argon2id 真登录 + sessions 表 + Cookie + CSRF）。
 *
 * P2 范围（阶段书 §4.1 #4）：
 * - 登录态：sessions 表（TTL 24h 滑动续期）+ HttpOnly SameSite=Lax Cookie（HMAC 签名）；
 * - dev 匿名开关 AGENTHUB_AUTH_DEV_ANON 保留（!== 'false' 时为开发后门，不发 Cookie）；
 * - CSRF：双提交 Cookie（.ai-spec 20-security.md SEC-5），写请求在 withIdentity 统一校验；
 * - 身份不由模型决定（.ai-spec 20-security.md BND-2）：userId 只来自本包服务端解析。
 *
 * @module @agenthub/auth
 */
export { AuthService, DEV_USER_ID, devAnonEnabled, type AuthUser, type AuthIdentity, type SignInResult, type SignUpInput, type SignInInput } from './service.ts'
export {
  SESSION_COOKIE,
  CSRF_COOKIE,
  SESSION_TTL_MS,
  parseCookies,
  sessionSetCookie,
  clearSessionCookie,
  verifiedSessionId,
  createCsrfToken,
  csrfSetCookie,
  verifyCsrf,
} from './cookies.ts'
export { hashPassword, verifyPassword } from './password.ts'
export { withIdentity, type IdentityContext } from './middleware.ts'
export { name, apply } from './plugin.ts'
