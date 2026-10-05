/**
 * 身份 + CSRF 中间件（.ai-spec 20-security.md SEC-4 / §4.2）：
 * 每请求解析 traceId（OBS-1）→ 解析登录态身份 → 写请求校验 CSRF 双提交 →
 * 移交业务 handler；业务异常统一转 U5 envelope 响应（plugin-skeleton §5.2）。
 * 表单体在此统一读取（身份/CSRF 之后、业务之前），避免重复消费请求流。
 *
 * @module @agenthub/auth/middleware
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  AgenthubError,
  getTraceId,
  sendError,
  TRACE_ID_KEY,
  traceIdOf,
  type Logger,
  type TraceId,
} from '@agenthub/_shared'
import { readFormBody } from '@agenthub/_shared'
import { CSRF_COOKIE, createCsrfToken, csrfSetCookie, parseCookies, verifyCsrf } from './cookies.ts'
import type { AuthService, AuthIdentity } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 请求级隔离服务；只在 withIdentity handler 生命周期内存在。 */
    readonly 'agenthub/traceId'?: TraceId
  }
}

/** 交给业务 handler 的每请求上下文。 */
export interface IdentityContext {
  readonly traceId: TraceId
  /** 本次请求独占的 Cordis 子上下文；traceId provider 在请求结束时自动释放。 */
  readonly requestContext: Context
  /** 服务端解析出的登录身份（.ai-spec 20-security.md BND-2：模型/请求参数不可决定）。 */
  readonly user: AuthIdentity
  /** CSRF 双提交令牌（渲染表单 `_csrf` 字段用；无 Cookie 时为本请求新签发值）。 */
  readonly csrfToken: string
  /** 表单体（POST/PUT/PATCH；中间件统一读取，业务层不得再读 req 流）。 */
  readonly form: URLSearchParams | undefined
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** 可能携带 `application/x-www-form-urlencoded` 正文的写方法（含连接白名单 PUT）。 */
const FORM_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/**
 * 包一层带身份/traceId/CSRF/错误兜底的路由 handler（上游 WebRoute.handler 签名）。
 * handler 抛出的任意异常都不会裸泄给客户端（fail-closed）。
 */
export function withIdentity(
  context: Context,
  auth: AuthService,
  handler: (req: IncomingMessage, res: ServerResponse, identity: IdentityContext) => void | Promise<void>,
  logger?: Logger,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const traceId = traceIdOf(req)
    const requestContext = context.isolate(TRACE_ID_KEY)
    const disposeTrace = requestContext.provide(TRACE_ID_KEY, traceId)
    try {
      const contextTraceId = getTraceId(requestContext)
      if (contextTraceId === null) {
        throw new AgenthubError('agenthub/auth/TraceContextMissing', '请求 TraceId 上下文未建立')
      }
      res.setHeader('x-trace-id', contextTraceId)
      const jar = parseCookies(req.headers.cookie)
      let csrfToken = jar[CSRF_COOKIE]
      if (csrfToken === undefined || csrfToken === '') {
        csrfToken = createCsrfToken()
        // 立即下发，不能延迟到 finally：业务 handler 会在本函数返回前写出响应体，
        // 届时 res.headersSent 已为 true，无法再补 Set-Cookie。
        appendSetCookie(res, csrfSetCookie(csrfToken))
      }
      const user = await auth.resolveIdentity(req)
      const method = (req.method ?? 'GET').toUpperCase()
      let form: URLSearchParams | undefined
      if (FORM_BODY_METHODS.has(method)) form = await readFormBody(req)
      if (WRITE_METHODS.has(method)) {
        const rawToken = req.headers['x-csrf-token']
        const headerToken = Array.isArray(rawToken) ? rawToken[0] : rawToken
        if (!verifyCsrf(jar, headerToken ?? form?.get('_csrf') ?? null)) {
          throw new AgenthubError('agenthub/auth/CsrfRejected', 'CSRF 校验失败', {
            httpStatus: 403,
          })
        }
      }
      await handler(req, res, {
        traceId: contextTraceId,
        requestContext,
        user,
        csrfToken,
        form,
      })
      logger?.info(
        { event: 'request.completed', projectId: null, userId: user.userId, traceId: contextTraceId, sessionId: user.sessionId },
        { method: req.method, path: req.url, status: res.statusCode },
      )
    } catch (error) {
      logger?.error(
        { event: 'request.failed', projectId: null, userId: null, traceId, sessionId: null },
        { path: req.url },
      )
      if (!res.headersSent) sendError(res, error, traceId)
      else res.destroy()
    } finally {
      disposeTrace()
    }
  }
}

/** 追加一条 Set-Cookie（与 handler 已下发的 Cookie 合并，不覆盖登录/登出 Cookie）。 */
function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('set-cookie')
  const previous = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]
  res.setHeader('set-cookie', [...previous, cookie])
}
