/**
 * 侧边浏览器登录中转（技术方案《侧边浏览器登录与凭证闭环》）。
 *
 * 三段路由，按 Host 区分站点：
 * - 平台主站 `GET /agenthub/connections/:id/authorize`：按平台登录态签发一次性票据，302 到登录站点；
 * - 登录站点 `GET /agenthub/connections/:id/enter?ticket=`：票据换中转会话，302 到会话前缀；
 * - 登录站点 `/agenthub/connections/:id/s/:sid/*`：转发外部系统前端与后端，前端带凭证访问时截取并加密保存。
 *
 * 硬边界：只转发该连接的前端与后端两个源；外部页面只运行在登录站点上，读不到平台主站的登录态；
 * 员工密码随登录表单原样转发，平台不解析、不记录；凭证与 Cookie 不回传浏览器，日志不含明文（BND-1）。
 *
 * @module @agenthub/system-connector/proxy
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AgenthubError,
  createLogger,
  sendError,
  sendRedirect,
  traceIdOf,
  type Logger,
} from '@agenthub/_shared'
import { COOKIE, cookieHeaderOf, mergeCookies, pickCredential } from './carrier.ts'
import type { LoginDesk, LoginSession } from './login-session.ts'
import { proxyPath, type SystemConnectorService } from './service.ts'
import type { ConnectorIdentityResolver, ConnectorTokenSource, SystemConnection } from './types.ts'

const AUTHORIZE_RE = /^\/agenthub\/connections\/([^/]+)\/authorize$/
const ENTER_RE = /^\/agenthub\/connections\/([^/]+)\/enter$/
const SESSION_RE = /^\/agenthub\/connections\/([^/]+)\/s\/([A-Za-z0-9_-]+)(?:\/(.*))?$/

/**
 * 这些头由中转自己处理，不原样透传。
 * 其余头（含外部系统自己的 `tenant-id` 等）必须原样带上，否则登录会被外部系统拒绝。
 */
const DROP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'cookie',
  'accept-encoding',
  'origin',
  'referer',
])

/** 状态变更方法（需同源 / CSRF 校验）。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 请求体 / 响应体大小上限（防内存放大）。 */
const MAX_BODY_BYTES = 1 * 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** 外部系统拒绝这份凭证时的状态码：凭证不保存。 */
const REJECTED_STATUSES = new Set([401, 403])

export interface AuthorizeHandlerOptions {
  readonly service: SystemConnectorService
  readonly vault: ConnectorTokenSource
  readonly auth: ConnectorIdentityResolver
  readonly desk: LoginDesk
  readonly fetchImpl?: typeof fetch
  readonly logger?: Logger
  /** 时钟注入（测试断言 expires_at）。 */
  readonly now?: () => Date
}

/** 路由 handler（`(req, res) => Promise<void>`，可直接交给 webServer.register）。 */
export function createAuthorizeHandler(
  options: AuthorizeHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const logger = options.logger ?? createLogger('agenthub/system-connector/proxy')
  const relay = createRelay(options, logger)

  return async (req, res) => {
    const traceId = traceIdOf(req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const onLoginHost = options.desk.isLoginHost(header(req, 'host') ?? undefined)
    try {
      const authorize = AUTHORIZE_RE.exec(url.pathname)
      if (authorize !== null && !onLoginHost) {
        const identity = await options.auth.resolveIdentity(req)
        const location = await options.service.startLogin(identity.userId, identity.roles, authorize[1] as string)
        logger.info(
          { event: 'connector.login-started', projectId: null, userId: identity.userId, traceId, sessionId: null },
          { connectionId: authorize[1] },
        )
        sendRedirect(res, location, traceId)
        return
      }
      const enter = ENTER_RE.exec(url.pathname)
      if (enter !== null && onLoginHost) {
        const connectionId = enter[1] as string
        const session = options.desk.enter(url.searchParams.get('ticket') ?? '', connectionId)
        if (session === null) {
          throw new AgenthubError(
            'agenthub/system-connector/LoginTicketInvalid',
            '登录链接已失效，请回到对话重新点击「去登录」',
            { httpStatus: 403 },
          )
        }
        logger.info(
          { event: 'connector.login-entered', projectId: null, userId: session.userId, traceId, sessionId: null },
          { connectionId },
        )
        sendRedirect(res, `${proxyPath(connectionId, session.id)}/`, traceId)
        return
      }
      const proxied = SESSION_RE.exec(url.pathname)
      if (proxied !== null && onLoginHost) {
        await relay(req, res, { connectionId: proxied[1] as string, sessionId: proxied[2] as string, rest: proxied[3], search: url.search, traceId })
        return
      }
      throw new AgenthubError('agenthub/system-connector/RouteNotFound', '未知的登录中转路径', { httpStatus: 404 })
    } catch (error) {
      logger.warn(
        { event: 'connector.proxy-failed', projectId: null, userId: null, traceId, sessionId: null },
        { path: url.pathname, message: error instanceof Error ? error.message : String(error) },
      )
      sendError(res, error, traceId)
    }
  }
}

interface RelayTarget {
  readonly connectionId: string
  readonly sessionId: string
  readonly rest: string | undefined
  readonly search: string
  readonly traceId: string
}

/** 中转一个请求：转发、截取凭证、改写页面。 */
function createRelay(
  options: AuthorizeHandlerOptions,
  logger: Logger,
): (req: IncomingMessage, res: ServerResponse, target: RelayTarget) => Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? ((): Date => new Date())
  return async (req, res, target) => {
    assertSameSite(req)
    const session = options.desk.session(target.sessionId, target.connectionId)
    if (session === null) {
      throw new AgenthubError(
        'agenthub/system-connector/LoginSessionInvalid',
        '登录页已过期，请回到对话重新点击「去登录」',
        { httpStatus: 403 },
      )
    }
    const connection = await options.service.getConnection(target.connectionId)
    options.service.assertOperationsAllowed(connection)
    const upstream = resolveProxyTarget(connection.frontendUrl, connection.baseUrl, target.rest, target.search)
    if (upstream === null) {
      throw new AgenthubError('agenthub/system-connector/ProxyOriginDenied', '中转仅限该连接的前端地址与后端地址', { httpStatus: 403 })
    }
    const credential = pickCredential(req.headers, connection.credentialHeaders)
    const headers = forwardHeaders(req)
    if (credential !== null) headers[credential.carrier] = credential.value
    const jar = cookieHeaderOf(session.cookies)
    if (jar !== null) headers.cookie = jar
    const body = await readBody(req)
    const init: RequestInit = { method: req.method ?? 'GET', headers }
    if (body !== undefined) init.body = new Uint8Array(body)
    const response = await fetchImpl(upstream, init)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new AgenthubError('agenthub/system-connector/ProxyResponseTooLarge', '中转响应体超过上限', { httpStatus: 502 })
    }
    const captured = await captureLogin(options.vault, session, credential, response, now())
    logger.info(
      { event: 'connector.proxy', projectId: connection.projectId, userId: session.userId, traceId: target.traceId, sessionId: null },
      { connectionId: connection.id, status: response.status, captured },
    )
    const raw = Buffer.from(await response.arrayBuffer())
    const buffer = rewriteDocument(raw, response.headers.get('content-type'), connection, proxyPath(connection.id, session.id), req)
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new AgenthubError('agenthub/system-connector/ProxyResponseTooLarge', '中转响应体超过上限', { httpStatus: 502 })
    }
    res.statusCode = response.status
    const contentType = response.headers.get('content-type')
    if (contentType !== null) res.setHeader('content-type', contentType)
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-trace-id', target.traceId)
    res.end(buffer)
  }
}

/**
 * 截取并保存凭证。请求头里的凭证优先；没有时用外部系统下发的 Cookie。
 * 外部系统拒绝本次请求时不保存。返回保存了哪种携带位置（未保存为 null）。
 */
async function captureLogin(
  vault: ConnectorTokenSource,
  session: LoginSession,
  credential: { carrier: string; value: string } | null,
  response: Response,
  at: Date,
): Promise<string | null> {
  const issued = captureCookie(response, at)
  const cookiesChanged = issued !== null && mergeCookies(session.cookies, issued.cookie)
  if (REJECTED_STATUSES.has(response.status)) return null
  if (credential !== null) {
    session.headerCaptured = true
    return await saveOnce(vault, session, credential.carrier, credential.value, null)
  }
  if (!cookiesChanged || session.headerCaptured) return null
  const jar = cookieHeaderOf(session.cookies)
  if (jar === null) return null
  return await saveOnce(vault, session, COOKIE, jar, issued?.expiresAt ?? null)
}

async function saveOnce(
  vault: ConnectorTokenSource,
  session: LoginSession,
  carrier: string,
  value: string,
  expiresAt: Date | null,
): Promise<string | null> {
  const digest = createHash('sha256').update(carrier).update('\n').update(value).digest('hex')
  if (session.savedDigest === digest) return null
  await vault.storeCredential({
    userId: session.userId,
    systemConnectionId: session.connectionId,
    plaintext: value,
    expiresAt,
    carrier,
  })
  session.savedDigest = digest
  return carrier
}

/**
 * 空路径打开前端地址（登录页）。`_api/` 前缀转到后端地址。
 * 其余路径相对前端源站。目标必须是这两个源之一。
 */
export function resolveProxyTarget(
  frontendUrl: string,
  backendUrl: string,
  rest: string | undefined,
  search: string,
): URL | null {
  const frontend = new URL(frontendUrl)
  const backend = new URL(backendUrl)
  let target: URL
  if (rest === undefined || rest === '') target = new URL(frontendUrl)
  else if (rest === '_api' || rest.startsWith('_api/')) {
    const path = rest === '_api' ? '/' : `/${rest.slice('_api/'.length)}`
    target = new URL(path + search, backend)
  } else target = new URL(resolveRest(rest) + search, frontend)
  if (target.origin !== frontend.origin && target.origin !== backend.origin) return null
  return target
}

/**
 * 改写中转后的 HTML：绝对源站 URL、根路径资源属性，并在 `<head>` 最前面放入
 * 不发 Referer 的声明、`<base>` 与请求改道脚本。
 * @param html - 外部系统返回的 HTML。
 * @param connection - 前端与后端地址。
 * @param mount - 本次中转会话的挂载前缀（不带结尾斜杠）。
 * @param requestHost - 登录站点的 `host[:port]`。
 * @param requestProto - 登录站点协议。
 * @returns 改写后的 HTML。
 */
export function rewriteProxyHtml(
  html: string,
  connection: { frontendUrl: string; baseUrl: string },
  mount: string,
  requestHost: string,
  requestProto = 'http',
): string {
  const prefix = `${requestProto}://${requestHost}${mount}`
  let text = html
  const frontendOrigin = new URL(connection.frontendUrl).origin
  const backendOrigin = new URL(connection.baseUrl).origin
  if (backendOrigin !== frontendOrigin) text = text.split(backendOrigin).join(`${prefix}/_api`)
  text = text.split(frontendOrigin).join(prefix)
  text = rewriteRootRelativeAttributes(text, mount)
  const head = '<meta name="referrer" content="no-referrer">'
    + `<base href="${prefix}/">`
    + `<script>${requestRouterScript(mount, frontendOrigin, backendOrigin === frontendOrigin ? null : backendOrigin)}</script>`
  return injectHead(text, head)
}

/** 模块脚本里的根路径导入（`from "/x"`、`import("/x")`、`import "/x"`）改到挂载前缀下。 */
export function rewriteModuleImports(source: string, mount: string): string {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])\/(?!\/|agenthub\/connections\/)/g,
    (_match, lead: string, quote: string) => `${lead}${quote}${mount}/`,
  )
}

/**
 * 页面里的 fetch / XMLHttpRequest 改道：发往前端源、后端源或登录站点根路径的请求
 * 一律改到挂载前缀下，保证前端带凭证访问后端时经过中转。其他源不动。
 */
function requestRouterScript(mount: string, frontendOrigin: string, backendOrigin: string | null): string {
  const literal = (value: string | null): string => JSON.stringify(value).replace(/</g, '\\u003c')
  return `(function(){var P=${literal(mount)},F=${literal(frontendOrigin)},B=${literal(backendOrigin)};`
    + 'function r(raw){var u;try{u=new URL(String(raw),document.baseURI)}catch(e){return raw}'
    + 'var t=u.pathname+u.search+u.hash;'
    + 'if(u.origin===location.origin){return u.pathname===P||u.pathname.indexOf(P+"/")===0?raw:P+t}'
    + 'if(B!==null&&u.origin===B)return P+"/_api"+t;'
    + 'if(u.origin===F)return P+t;return raw}'
    + 'var f=window.fetch;if(f){window.fetch=function(i,o){'
    + 'if(typeof Request!=="undefined"&&i instanceof Request){var n=r(i.url);if(n!==i.url)i=new Request(n,i)}else{i=r(i)}'
    + 'return f.call(this,i,o)}}'
    + 'var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){'
    + 'var a=Array.prototype.slice.call(arguments);a[1]=r(a[1]);return x.apply(this,a)}})();'
}

/** `src|href|action="/…"` → 挂载前缀下（跳过 `//` 与已写入的 agenthub 路径）。 */
function rewriteRootRelativeAttributes(html: string, mount: string): string {
  return html.replace(
    /\b(src|href|action)=(["'])\/(?!\/|agenthub\/connections\/)([^"']*)/gi,
    (_match, attr: string, quote: string, rest: string) => `${attr}=${quote}${mount}/${rest}`,
  )
}

function injectHead(html: string, tags: string): string {
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tags}`)
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${tags}</head>`)
  return `${tags}${html}`
}

/** HTML 与模块脚本改写；其他类型原样返回。 */
function rewriteDocument(
  body: Buffer,
  contentType: string | null,
  connection: SystemConnection,
  mount: string,
  req: IncomingMessage,
): Buffer {
  if (contentType === null) return body
  if (contentType.includes('javascript')) return Buffer.from(rewriteModuleImports(body.toString('utf8'), mount))
  if (!contentType.includes('text/html')) return body
  const host = header(req, 'host')
  if (host === null) return body
  const proto = header(req, 'x-forwarded-proto') ?? 'http'
  return Buffer.from(rewriteProxyHtml(body.toString('utf8'), connection, mount, host, proto))
}

/** 空路径 → `/`；拒绝 `//`、`://` 等越界写法。 */
function resolveRest(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '/'
  const decoded = decodeURIComponent(raw)
  if (decoded.startsWith('//') || decoded.includes('://')) {
    throw new AgenthubError('agenthub/system-connector/ProxyPathDenied', '中转路径非法', { httpStatus: 400 })
  }
  return `/${decoded}`
}

function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, raw] of Object.entries(req.headers)) {
    if (DROP_HEADERS.has(name)) continue
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value !== undefined && value !== '') headers[name] = value
  }
  return headers
}

/** 读取请求头（重复取首个）；缺失 → null。 */
function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

/**
 * 状态变更方法同源守卫：拒绝 `Sec-Fetch-Site: cross-site`，且若带 `Origin` 则必须与请求 `Host` 一致。
 * 无浏览器跨站信号（无 Origin / 无 Sec-Fetch-Site，如服务端到服务端）放行。
 */
function assertSameSite(req: IncomingMessage): void {
  const method = (req.method ?? 'GET').toUpperCase()
  if (!WRITE_METHODS.has(method)) return
  const site = header(req, 'sec-fetch-site')
  if (site !== null && site.toLowerCase() === 'cross-site') {
    throw new AgenthubError('agenthub/system-connector/ProxyCsrfDenied', '跨站写请求被拒绝', { httpStatus: 403 })
  }
  const origin = header(req, 'origin')
  if (origin === null) return
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new AgenthubError('agenthub/system-connector/ProxyCsrfDenied', 'Origin 非法，拒绝', { httpStatus: 403 })
  }
  const host = header(req, 'host')
  if (host === null || parsed.host !== host) {
    throw new AgenthubError('agenthub/system-connector/ProxyCsrfDenied', 'Origin 与请求源不一致，拒绝', { httpStatus: 403 })
  }
}

/** 读取请求体（GET/HEAD 无体）；超过上限 → 413。用于转发外部系统登录表单。 */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.byteLength
    if (total > MAX_BODY_BYTES) {
      throw new AgenthubError('agenthub/system-connector/ProxyBodyTooLarge', '中转请求体超过上限', { httpStatus: 413 })
    }
    chunks.push(buf)
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

/**
 * 读取响应下发的 Cookie（仅取 `name=value`，按 `Max-Age` 推 expiresAt）。
 * 返回 null 表示该响应未下发 Cookie。
 */
export function captureCookie(
  response: Response,
  at: Date,
): { cookie: string; expiresAt: Date | null } | null {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const pairs: string[] = []
  let maxAgeSeconds: number | null = null
  for (const line of lines) {
    const [pair, ...attrs] = line.split(';')
    if (pair !== undefined && pair.trim() !== '') pairs.push(pair.trim())
    for (const attr of attrs) {
      const match = /^\s*max-age=(\d+)\s*$/i.exec(attr)
      if (match !== null) maxAgeSeconds = Number(match[1])
    }
  }
  if (pairs.length === 0) return null
  return {
    cookie: pairs.join('; '),
    expiresAt: maxAgeSeconds === null ? null : new Date(at.getTime() + maxAgeSeconds * 1000),
  }
}
