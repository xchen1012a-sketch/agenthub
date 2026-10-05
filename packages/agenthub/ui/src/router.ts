/**
 * /agenthub/* 页面路由（纯函数 dispatch，plugin.ts 只做 HTTP 壳）。
 *
 * 路径约定 U2（plugin-skeleton §6）：/agenthub/login、/agenthub/projects、/agenthub/projects/<id>。
 * 登录页匿名可达；projects 全部走 withIdentity 解析出的服务端身份 + rbac requirePlatformAdmin。
 * 身份来自请求对象（.ai-spec 20-security.md BND-2：不读任何表单/模型传入的用户标识）。
 *
 * @module @agenthub/ui/router
 */
import type { IncomingMessage } from 'node:http'
import {
  AgenthubError,
  asProjectId,
  createLogger,
  isAgenthubError,
  toErrorEnvelope,
  type Logger,
  type TraceId,
} from '@agenthub/_shared'
import type { AuthService, AuthIdentity } from '@agenthub/auth'
import type { RbacService } from '@agenthub/rbac'
import type { ProjectService } from '@agenthub/project'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ApprovalDecision, ApprovalRecord } from '@agenthub/approval'
import { pickLocale, t, type Locale } from './i18n.ts'
import { errorPage, loginPage, projectDetailPage, projectsPage, sessionsPage } from './render.ts'
import { handleAgenthubApi, type ApiDeps } from './api.ts'

/**
 * dispatch 依赖面（领域服务的最小方法集）。
 * db/connector/vault/ingest 为阶段 D JSON API 的可选依赖：全部 `?` 以保持既有测试可编译；
 * 运行期缺失时对应接口抛 `agenthub/ui/ServiceUnavailable`（503）。
 */
export interface RouterDeps extends ApiDeps {
  readonly auth: AuthService
  readonly rbac: RbacService
  readonly project: ProjectService
  /** T9：Session 持久化（/agenthub/sessions 管理台列表）。 */
  readonly sessions: SessionPersistence
  /** 审批门（P3 阶段 B：/agenthub/api/approvals JSON API）。 */
  readonly approval: {
    decide(approvalId: string, approverId: string, decision: ApprovalDecision, reason?: string): Promise<ApprovalRecord>
    listApprovals(viewerId: string, status?: string): Promise<ApprovalRecord[]>
  }
}

/** dispatch 结果（plugin.ts 负责映射到 ServerResponse）。 */
export interface RouteResult {
  readonly status: number
  /** 302 时的跳转目标。 */
  readonly location?: string
  readonly html?: string
  /** JSON 响应体（/agenthub/api/* 路由；U5 envelope 由 sendJson/错误路径保证）。 */
  readonly json?: unknown
  /** 需下发的 Set-Cookie 值（登录/登出）。 */
  readonly cookies?: readonly string[]
}

export interface RouteRequest {
  readonly method: string
  /** 去掉 query 的路径，形如 /agenthub/projects/<id>。 */
  readonly path: string
  /** query 参数（/agenthub/api/approvals?status=...）。 */
  readonly query: URLSearchParams
  readonly acceptLanguage: string | undefined
  /** POST 表单体（仅 POST 路由消费；withIdentity 已做 CSRF 校验）。 */
  readonly form: URLSearchParams | undefined
  readonly traceId: TraceId | string
  /** withIdentity 解析出的服务端身份。 */
  readonly user: AuthIdentity
  /** CSRF 双提交令牌（渲染表单 `_csrf` 隐藏字段）。 */
  readonly csrfToken: string
  /** 原始 Cookie 头（登出时定位待删除会话）。 */
  readonly cookieHeader: string | undefined
}

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const logger: Logger = createLogger('agenthub/ui')

export async function handleAgenthubRequest(deps: RouterDeps, req: RouteRequest): Promise<RouteResult> {
  const locale: Locale = pickLocale(req.acceptLanguage)
  try {
    if (req.path.startsWith('/agenthub/api/')) return await handleApi(deps, req)

    if (req.path === '/agenthub' || req.path === '/agenthub/login') {
      if (req.method === 'POST') return await handleLogin(deps, req)
      if (req.method === 'GET') return { status: 200, html: loginPage(locale, req.csrfToken, deps.auth.devAnon) }
      return methodNotAllowed()
    }

    if (req.path === '/agenthub/logout') {
      if (req.method !== 'POST') return methodNotAllowed()
      await deps.auth.signOut({ headers: { cookie: req.cookieHeader } } as IncomingMessage)
      return { status: 302, location: '/agenthub/login', cookies: [deps.auth.sessionClearCookie] }
    }

    if (req.path === '/agenthub/sessions') {
      // Harness Session 无用户维度：P2 管理台语义，仅 platform_admin 可查看全量。
      const user = req.user
      deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
      if (req.method !== 'GET') return methodNotAllowed()
      const snapshots = await deps.sessions.list()
      return {
        status: 200,
        html: sessionsPage(
          locale,
          snapshots.map(snapshot => ({
            id: snapshot.header.id,
            createdAt: snapshot.header.createdAt,
            eventCount: snapshot.eventCount,
          })),
        ),
      }
    }

    if (req.path === '/agenthub/projects') {
      const user = req.user
      deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
      if (req.method === 'GET') {
        const projects = await deps.project.listProjects(user.userId)
        return { status: 200, html: projectsPage(locale, projects) }
      }
      if (req.method === 'POST') {
        const name = req.form?.get('name') ?? ''
        const record = await deps.project.createProject({ userId: user.userId, name }, req.traceId)
        return { status: 302, location: `/agenthub/projects/${record.id}` }
      }
      return methodNotAllowed()
    }

    const detail = req.path.match(/^\/agenthub\/projects\/([^/]+)$/)
    if (detail !== null && req.method === 'GET') {
      const id = detail[1] ?? ''
      if (!PROJECT_ID_RE.test(id)) {
        return { status: 404, html: errorPage(locale, t(locale, 'error.title')) }
      }
      // resolveProjectContext 已加载 record 并校验成员 → name 一并返回（避免 N+1 + 跨成员 listProjects 漏命中）。
      const context = await deps.project.resolveProjectContext(req.user.userId, asProjectId(id))
      return { status: 200, html: projectDetailPage(locale, context.name, context.workspaceId) }
    }

    return { status: 404, html: errorPage(locale, t(locale, 'error.title')) }
  } catch (error) {
    // 兜底日志：未预期异常不能静默吞掉（data 过 redact 后落结构化日志）。
    logger.error(
      {
        event: 'request.failed',
        projectId: null,
        userId: null,
        traceId: typeof req.traceId === 'string' ? req.traceId : null,
        sessionId: null,
      },
      { path: req.path, reason: error instanceof Error ? error.message : String(error) },
    )
    // JSON API 错误同构 U5 envelope（不能把 HTML 错误页发给 fetch 调用方）。
    if (req.path.startsWith('/agenthub/api/')) {
      return {
        status: isAgenthubError(error) ? error.httpStatus : 500,
        json: toErrorEnvelope(error, req.traceId),
      }
    }
    const status = isAgenthubError(error) ? error.httpStatus : 500
    const message = toErrorEnvelope(error, req.traceId).message
    return { status, html: errorPage(locale, message) }
  }
}

/**
 * /agenthub/api/* JSON API（P3 阶段 B：审批；阶段 C/D 续接连接/工具/凭证）。
 * 写路径径 withIdentity 已做 CSRF（x-csrf-token 头或 _csrf 表单字段）；
 * 请求体为表单编码（与登录流同构），响应恒为 JSON（U5）。
 */
async function handleApi(deps: RouterDeps, req: RouteRequest): Promise<RouteResult> {
  const user = req.user

  if (req.path === '/agenthub/api/approvals') {
    if (req.method !== 'GET') return methodNotAllowedJson()
    const status = req.query.get('status') ?? undefined
    const items = await deps.approval.listApprovals(user.userId, status)
    return { status: 200, json: { items } }
  }

  const decide = req.path.match(/^\/agenthub\/api\/approvals\/([^/]+)\/decide$/)
  if (decide !== null) {
    if (req.method !== 'POST') return methodNotAllowedJson()
    const id = decide[1] ?? ''
    if (!PROJECT_ID_RE.test(id)) {
      throw new AgenthubError('agenthub/ui/ApprovalNotFound', '审批记录不存在', { httpStatus: 404 })
    }
    const decision = req.form?.get('decision') ?? ''
    if (decision !== 'approve' && decision !== 'reject') {
      throw new AgenthubError('agenthub/ui/InvalidRequest', 'decision 必须为 approve 或 reject', { httpStatus: 400 })
    }
    const reason = req.form?.get('reason')?.trim() ?? ''
    const record = await deps.approval.decide(id, user.userId, decision, ...(reason === '' ? [] : [reason]))
    return { status: 200, json: record }
  }

  // 阶段 D T7：tools / connections / analytics / badcases / admin / projects 等（见 api.ts）。
  return await handleAgenthubApi(deps, req)
}

function methodNotAllowedJson(): RouteResult {
  throw new AgenthubError('agenthub/ui/MethodNotAllowed', 'method not allowed', { httpStatus: 405 })
}

/** 登录：dev 匿名模式直通；真登录走 email + password（Argon2id），mode=register 先注册再登录。 */
async function handleLogin(deps: RouterDeps, req: RouteRequest): Promise<RouteResult> {
  if (deps.auth.devAnon) {
    // dev 模式身份由 withIdentity 自动解析（devIdentity 幂等 upsert 用户行）。
    return { status: 302, location: '/agenthub/projects' }
  }
  const email = req.form?.get('email') ?? ''
  const password = req.form?.get('password') ?? ''
  if (req.form?.get('mode') === 'register') {
    const displayName = req.form.get('displayName') ?? ''
    await deps.auth.signUp({ email, displayName, password })
  }
  const result = await deps.auth.signIn({ email, password }, req.traceId)
  return {
    status: 302,
    location: '/agenthub/projects',
    cookies: [deps.auth.sessionCookie(result.sessionId)],
  }
}

function methodNotAllowed(): RouteResult {
  return { status: 405, html: '' }
}
