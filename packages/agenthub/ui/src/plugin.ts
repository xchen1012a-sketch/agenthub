/**
 * Cordis 插件入口：注册 /agenthub 前缀路由（上游 ctx.webServer，优先于 SPA fallback）。
 *
 * 注册顺序（plugin-skeleton §3）：ui 在 auth / rbac / project 之后。
 *
 * @module @agenthub/ui/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { createLogger, sendHtml, sendJson, sendRedirect, type Queryable } from '@agenthub/_shared'
import { withIdentity, type AuthService } from '@agenthub/auth'
import type { RbacService } from '@agenthub/rbac'
import type { ProjectService } from '@agenthub/project'
import type { ApprovalGateService } from '@agenthub/approval'
import { handleAgenthubRequest, type RouterDeps } from './router.ts'
import type { AnalyticsLike, AuditLike, ConnectorLike, IngestLike, MemoryLike, VaultLike } from './api.ts'

export const name = '@agenthub/ui' as const

/** 静态依赖元数据（loader 读取）；运行时以 ctx.inject 真正门禁。 */
export const inject = [
  'webServer',
  'agenthub/auth',
  'agenthub/rbac',
  'agenthub/project',
  'agenthub/approval',
  'sessionPersistence',
  'workspaceRegistry',
  'agenthub/db',
  'agenthub/system-connector',
  'agenthub/vault',
  'agenthub/openapi-ingest',
  'agenthub/project-memory',
  'agenthub/audit',
  'agenthub/analytics',
  'agenthub/tool-scope',
] as const

/** 依赖经 §4.2 ctx.inject 声明式等待：webServer + 安全/领域服务 + Session 持久化 + 阶段 D JSON API 服务。 */
export function apply(ctx: Context): void {
  ctx.inject(
    [
      'webServer',
      'agenthub/auth',
      'agenthub/rbac',
      'agenthub/project',
      'agenthub/approval',
      'sessionPersistence',
      'workspaceRegistry',
      'agenthub/db',
      'agenthub/system-connector',
      'agenthub/vault',
      'agenthub/openapi-ingest',
      'agenthub/project-memory',
      'agenthub/audit',
      'agenthub/analytics',
      'agenthub/tool-scope',
    ],
    (injected) => {
      // exactOptionalPropertyTypes：未装配时不传该键，而不是传 undefined。
      const scanProgress = injected.get('agenthub/openapi-ingest/progress') as RouterDeps['scanProgress']
      const connector = injected.get('agenthub/system-connector') as ConnectorLike
      const deps: RouterDeps = {
        auth: injected.get('agenthub/auth') as AuthService,
        rbac: injected.get('agenthub/rbac') as RbacService,
        project: injected.get('agenthub/project') as ProjectService,
        approval: injected.get('agenthub/approval') as ApprovalGateService,
        sessions: injected.get('sessionPersistence') as SessionPersistence,
        db: injected.get('agenthub/db') as Queryable,
        connector,
        vault: injected.get('agenthub/vault') as VaultLike,
        ingest: injected.get('agenthub/openapi-ingest') as IngestLike,
        memory: injected.get('agenthub/project-memory') as MemoryLike,
        audit: injected.get('agenthub/audit') as AuditLike,
        analytics: injected.get('agenthub/analytics') as AnalyticsLike,
        toolScope: injected.get('agenthub/tool-scope') as NonNullable<RouterDeps['toolScope']>,
        workspaces: injected.get('workspaceRegistry') as NonNullable<RouterDeps['workspaces']>,
        ...(scanProgress === undefined ? {} : { scanProgress }),
      }
      const webServer = injected.get('webServer') as Context['webServer']
      webServer.register({
        kind: 'prefix',
        path: '/agenthub',
        // 统一经 withIdentity 入口（.ai-spec 20-security.md SEC-4 / §4.2 / U5）：traceId 解析、身份门禁、
        // CSRF 双提交校验、表单体读取与错误 envelope 都在一处生效。
        handler: withIdentity(
          injected,
          deps.auth,
          async (req, res, identity) => {
            const loginHost = connector.loginHost?.() ?? null
            const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
            if (loginHost !== null && host === loginHost.toLowerCase()) {
              sendJson(res, 404, { code: 'agenthub/ui/NotFound', message: 'not found', traceId: identity.traceId }, identity.traceId)
              return
            }
            const traceId = identity.traceId
            const url = new URL(req.url ?? '/agenthub', 'http://x')
            const result = await handleAgenthubRequest(deps, {
              method: req.method ?? 'GET',
              path: url.pathname,
              query: url.searchParams,
              acceptLanguage: req.headers['accept-language'],
              form: identity.form,
              traceId,
              user: identity.user,
              csrfToken: identity.csrfToken,
              cookieHeader: req.headers.cookie,
            })
            if (result.cookies !== undefined && result.cookies.length > 0) {
              // 追加而非覆盖：withIdentity 已可能下发 CSRF 双提交 Cookie。
              const existing = res.getHeader('set-cookie')
              const previous = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]
              res.setHeader('set-cookie', [...previous, ...result.cookies])
            }
            if (result.location !== undefined) {
              sendRedirect(res, result.location, traceId)
              return
            }
            if (result.json !== undefined) {
              sendJson(res, result.status, result.json, traceId)
              return
            }
            if (result.html === undefined || result.html === '') {
              res.statusCode = result.status
              res.setHeader('x-trace-id', traceId)
              res.end()
              return
            }
            sendHtml(res, result.status, result.html, traceId)
          },
          createLogger('agenthub/ui'),
        ),
      })
    },
  )
}
