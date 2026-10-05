/**
 * /agenthub/api/* JSON API 实现（P3 方案书阶段 D T7）。
 *
 * 消费真实领域服务与唯一 DB 连接（`agenthub/db`）：Tool Registry、系统连接健康、
 * 运营分析（audit/approvals/badcases 聚合）、坏例、平台用户/角色、Project 选项，
 * 以及连接创建 / 连接扫描 / Tool 启停 / Project 凭证写入等写操作。
 *
 * 约束：
 * - 身份只来自 `req.user`（withIdentity 服务端解析），表单/模型不可决定；
 * - SQL 显式列名（禁 SELECT *），参数化占位符；
 * - 查不到即返回空集/零值，绝不编造占位数据；
 * - 领域服务缺失（未装配）→ `agenthub/ui/ServiceUnavailable`（503）。
 *
 * @module @agenthub/ui/api
 */
import { AgenthubError, asProjectId, asWorkspaceId, type Queryable } from '@agenthub/_shared'
import type { RbacService } from '@agenthub/rbac'
import type { ProjectService } from '@agenthub/project'
import type { ApprovalDecision, ApprovalRecord } from '@agenthub/approval'
import { BADCASE_CAUSES } from '@agenthub/audit'
import type { RouteRequest, RouteResult } from './router.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** tools.risk_level 值域（0007）：read / write / sensitive / critical。 */
export type ToolRisk = 'read' | 'write' | 'sensitive' | 'critical'

/** Tool 生命周期状态：enabled / draft / disabled（派生，非存储列）。 */
export type ToolStatus = 'enabled' | 'draft' | 'disabled'

/** badcases.category 八态（0012）。 */
export type BadcaseCause =
  | 'wrong_tool'
  | 'bad_param'
  | 'upstream_error'
  | 'permission_denied'
  | 'model_misunderstanding'
  | 'prompt_injection'
  | 'timeout'
  | 'unknown'

/** 一条 Tool Registry 记录（GET /agenthub/api/tools）。 */
export interface ToolRecord {
  readonly id: string
  readonly name: string
  readonly api: string
  readonly method: string
  readonly path: string
  readonly source: string
  readonly risk: ToolRisk
  readonly approval: boolean
  readonly status: ToolStatus
  readonly usedBy: readonly string[]
  readonly desc: string
  readonly params: string
  readonly result: string
}

/** 一条系统连接健康记录（GET /agenthub/api/connections）。 */
export interface ConnectionHealthRecord {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly frontendUrl: string
  readonly projectId: string | null
  readonly pendingHosts: readonly string[]
  readonly type: 'openapi' | 'manual'
  readonly auth: string
  readonly status: 'healthy' | 'degraded'
  readonly tools: number
  readonly lastCheck: string
  /** 出站目标白名单（C-4 授权路径）；空数组 = 受限地址全拒。 */
  readonly allowedHosts: readonly string[]
}

/** 运营分析 KPI 块（GET /agenthub/api/analytics）。 */
export interface AnalyticsKpi {
  readonly dau: number
  readonly sessions: number
  readonly toolCalls: number
  readonly successRate: number
  readonly badcaseRate: number
  readonly approvalRate: number
}

/** 运营分析快照（GET /agenthub/api/analytics?window=14d）。 */
export interface AnalyticsRecord {
  readonly kpi: AnalyticsKpi
  /** 各 KPI 环比百分数（整数；0/持平 → null，由前端 i18n 渲染，U4）。 */
  readonly deltas: {
    readonly dau: number | null
    readonly sessions: number | null
    readonly toolCalls: number | null
    readonly successRate: number | null
    readonly badcaseRate: number | null
    readonly approvalRate: number | null
  }
  readonly toolTrend: readonly number[]
  readonly failCauses: readonly { readonly cause: BadcaseCause; readonly count: number }[]
  readonly topTools: readonly { readonly api: string; readonly count: number }[]
}

/** 一条坏例记录（GET /agenthub/api/badcases）。 */
export interface BadcaseRecord {
  readonly id: string
  readonly question: string
  readonly answer: string
  readonly cause: BadcaseCause
  readonly causeDetail: string
  readonly project: string
  readonly user: string
  readonly status: 'resolved' | 'open'
  readonly createdAt: string
  readonly session: string
  readonly tool: string
}

/** 一条平台用户记录（GET /agenthub/api/admin/users）。 */
export interface UserRecord {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly role: string
  readonly active: boolean
}

/** 一条平台角色记录（GET /agenthub/api/admin/roles）。 */
export interface RoleRecord {
  readonly name: string
  readonly desc: string
  readonly members: number
  readonly builtin: boolean
}

/** Project 选项（GET /agenthub/api/projects，当前用户可见）。 */
export interface ProjectOption {
  readonly id: string
  readonly name: string
  /** 该项目自己的对话空间。选择项目后在这里新开会话。 */
  readonly workspaceId: string
}

/** system_connections 视图（与 @agenthub/system-connector 的 SystemConnection 结构相同；结构化声明避免跨包 import）。 */
export interface SystemConnectionLike {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly frontendUrl?: string
  readonly projectId?: string | null
  readonly pendingHosts?: readonly string[]
  readonly authMode: string
  readonly openapiUrl: string | null
  readonly hasOpenapiDoc: boolean
  /** 出站目标白名单（C-4 授权路径）；空数组 = 受限地址全拒。 */
  readonly allowedHosts?: readonly string[]
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 系统连接服务的结构化依赖面（实现由 @agenthub/system-connector provide）。 */
export interface ConnectorLike {
  listConnections(): Promise<SystemConnectionLike[]>
  createConnection(input: {
    userId: string
    projectId: string
    name: string
    baseUrl: string
    frontendUrl: string
    openapiUrl?: string | null
    allowedHosts?: readonly string[]
  }): Promise<SystemConnectionLike>
  /** 局部更新连接（改文档地址或白名单时，服务端按生效组合重新校验）。 */
  updateConnection?(id: string, patch: {
    openapiUrl?: string | null
    allowedHosts?: readonly string[]
    authMode?: string
  }): Promise<SystemConnectionLike>
  /** C-5：启 / 停 Tool 后按当前 enabled 重注册 connector Tool（可选，未装配时跳过）。 */
  reloadTools?(): Promise<void>
  /**
   * 为当前员工签发登录入口（一次性票据）。未装配时登录卡片不可用。
   * 员工身份必须来自服务端登录态（BND-2）。
   */
  startLogin?(userId: string, roles: readonly string[], connectionId: string): Promise<string>
  /** 登录站点 Host；平台主站据此拒绝落在登录站点上的 /agenthub 请求。 */
  loginHost?(): string | null
}

/** 凭证 Vault 的结构化依赖面（实现由 @agenthub/credential-vault provide）。 */
export interface VaultLike {
  storeCredential(input: {
    userId: string
    systemConnectionId: string
    plaintext: string
    externalUserId?: string | null
    expiresAt?: Date | string | null
  }): Promise<{ id: string; keyVersion: number; expiresAt: string | null }>
  /** 只读到期状态，不解密（SEC-2）。 */
  credentialStatus?(userId: string, systemConnectionId: string): Promise<'missing' | 'expired' | 'ready'>
}

/** OpenAPI 导入服务的结构化依赖面（实现由 @agenthub/openapi-ingest provide）。 */
export interface IngestLike {
  ingestFromUrl(
    id: string,
    options?: { createdBy?: string | null },
  ): Promise<{ created: string[]; skipped: { name: string; sourceRef: string; reason: string }[]; total: number }>
}

/**
 * 运营分析服务的结构化依赖面（由 `@agenthub/analytics` provide）。
 *
 * `aggregate` 的返回面只声明本文件需要的字段（结构化子集），
 * 使 ui 不直接依赖 analytics 包的完整类型面。
 */
export interface AnalyticsLike {
  aggregate(window: string | null): Promise<{
    readonly toolCalls: number
    readonly successRate: number
    readonly activeUsers: number
    readonly sessions: number
    readonly approvals: number
    readonly previous: {
      readonly toolCalls: number
      readonly successRate: number
      readonly badcaseTotal: number
      readonly activeUsers: number
      readonly sessions: number
    }
    readonly previousApprovals: number
    readonly badcaseTotal: number
    readonly badcaseDistribution: readonly { readonly cause: string; readonly count: number }[]
    readonly toolTrend: readonly number[]
    readonly topTools: readonly { readonly api: string; readonly count: number }[]
  }>
}

/** 阶段 D JSON API 依赖面（全部可选；运行期缺失 → 503，保持既有测试可编译）。 */
/** 一条 Project 记忆（GET /agenthub/api/projects/:id/memories）。 */
export interface MemoryRecord {
  readonly id: string
  readonly projectId: string
  readonly content: string
  /** candidate = 待人工确认（不入注入）；active = 已生效。 */
  readonly status: 'candidate' | 'active'
  readonly locked: boolean
  /** 软删标记（检索与列表均排除；软删行仅管理台回溯可见）。 */
  readonly deleted: boolean
  /**
   * 产出该候选的会话 id。
   * 记忆服务当前未在返回面暴露它，故服务侧实现可省略；路由序列化时缺省补 `null`。
   */
  readonly sourceSessionId?: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * 记忆领域服务的最小方法集（`@agenthub/project-memory` 满足此结构）。
 *
 * 全部写方法**必须**以 (id, projectId) 双条件定位：归属判定与写操作在同一条 SQL 内完成
 * （`.ai-spec/00-boundaries.md` BND-4 / D33），跨 Project 命中 0 行返回 null / false。
 */
export interface MemoryLike {
  listMemories(
    projectId: string,
    options?: { scope?: 'candidate' | 'active'; includeDeleted?: boolean },
  ): Promise<readonly MemoryRecord[]>
  listCandidates(projectId: string): Promise<readonly MemoryRecord[]>
  confirmCandidate(id: string, projectId: string): Promise<MemoryRecord | null>
  rejectCandidate(id: string, projectId: string): Promise<boolean>
  setLocked(id: string, locked: boolean, projectId: string): Promise<MemoryRecord | null>
  softDelete(id: string, projectId: string): Promise<boolean>
  hardDelete(id: string, projectId: string): Promise<boolean>
}

/** audit_records.status 四枚举（0008 CHECK）。 */
export type AuditStatus = 'ok' | 'error' | 'denied' | 'pending'

const AUDIT_STATUSES: readonly AuditStatus[] = ['ok', 'error', 'denied', 'pending']

/** 单页默认 / 上限条数（上限防止一次拉爆内存）。 */
const AUDIT_DEFAULT_LIMIT = 50
const AUDIT_MAX_LIMIT = 200

/** 一条审计记录（GET /agenthub/api/audit）。 */
export interface AuditRecord {
  readonly id: string
  readonly projectId: string | null
  readonly userId: string | null
  readonly sessionId: string | null
  readonly toolId: string | null
  readonly toolName: string
  readonly risk: string
  readonly status: string
  readonly traceId: string
  readonly createdAt: string
}

/**
 * 审计查询服务的最小方法集（`@agenthub/audit` 满足此结构）。
 *
 * `projectId` 必填：查询面恒带项目归属，调用方拿不到跨项目的入口（`BND-4`）。
 */
export interface AuditLike {
  listRecords(filter: {
    projectId: string
    userId?: string
    toolId?: string
    status?: AuditStatus
    from?: string
    to?: string
    limit?: number
    offset?: number
  }): Promise<{
    items: readonly {
      id: string
      project_id: string | null
      user_id: string | null
      session_id: string | null
      tool_id: string | null
      tool_name: string
      risk_level: string
      status: string
      trace_id: string
      created_at: Date | string
    }[]
    total: number
  }>
  /** P5：登记坏例（幂等；跨项目审计记录被拒）。 */
  markBadcase(input: {
    auditId: string
    projectId: string
    category: BadcaseCause
    note?: string | null
    markedBy: string
  }): Promise<BadcaseRowLike>
  /** P5：坏例销号；未命中（不存在或跨项目）→ null。 */
  resolveBadcase(badcaseId: string, projectId: string, resolvedBy: string): Promise<BadcaseRowLike | null>
  /** P5：查坏例归属项目，供路由先取归属再做成员校验。 */
  findBadcaseProject(badcaseId: string): Promise<string | null>
}

/** 扫描阶段（与 `@agenthub/openapi-ingest` 的 ScanPhase 同义；此处只是结构化子集）。 */
export type ScanPhaseLike = 'fetching' | 'parsing' | 'grading' | 'writing' | 'done' | 'failed'

/** 一次扫描的对外进度（弹窗据此渲染；`total` 未知时显示不确定态）。 */
export interface ScanProgressLike {
  readonly connectionId: string
  readonly phase: ScanPhaseLike
  readonly processed: number
  readonly total: number | null
  readonly reason?: string
  readonly created?: number
  readonly skipped?: number
  readonly startedAt: string
  readonly finishedAt?: string
}

/** 一条坏例行（服务返回面；ui 只声明本文件使用的字段）。 */
export interface BadcaseRowLike {  readonly id: string
  readonly audit_id: string
  readonly category: BadcaseCause
  readonly category_note: string | null
  readonly resolved: boolean
  readonly resolved_by: string | null
  readonly resolved_at: Date | string | null
  readonly created_at: Date | string
}

export interface ApiDeps {
  readonly db?: Queryable
  readonly connector?: ConnectorLike
  readonly vault?: VaultLike
  readonly ingest?: IngestLike
  /** 阶段 C：Project 记忆读写（未装配 → 503）。 */
  readonly memory?: MemoryLike
  /** 阶段 C3-B：审计查询；P5：坏例登记与销号（未装配 → 503）。 */
  readonly audit?: AuditLike
  /**
   * 扫描进度注册表（未装配 → 扫描退回同步语义、进度接口 503）。
   *
   * 用结构化子集而非 import 该包类型：ui 只需要这三个方法。
   */
  readonly scanProgress?: {
    get(connectionId: string): ScanProgressLike | undefined
    isRunning(connectionId: string): boolean
  }
  /** P5：运营指标聚合（未装配 → 503；不再回落到内联 SQL）。 */
  readonly analytics?: AnalyticsLike
  /** 打开项目对话时登记会话主人；未装配则会话不会绑定业务身份。 */
  readonly toolScope?: {
    expectChat(projectId: string, userId: string): void
  }
  /** 工作目录 → 工作区；登录卡片用它把当前会话落到项目。 */
  readonly workspaces?: {
    resolveByPath(path: string): Promise<{ readonly id: unknown } | undefined>
  }
}

/** 阶段 D JSON API 端到端依赖（router 的 RouterDeps 满足此结构）。 */
export interface JsonApiDeps extends ApiDeps {
  readonly rbac: RbacService
  readonly project: ProjectService
  readonly approval: {
    decide(approvalId: string, approverId: string, decision: ApprovalDecision, reason?: string): Promise<ApprovalRecord>
    listApprovals(viewerId: string, status?: string): Promise<ApprovalRecord[]>
  }
}

const ROLE_DISPLAY: Record<string, string> = {
  platform_admin: 'Platform Admin',
  project_admin: 'Project Admin',
  member: 'Member',
  approver: 'Approver',
}

const ROLE_DESC: Record<string, string> = {
  platform_admin: '平台管理员：全局配置、系统连接、Tool Registry、用户与权限',
  project_admin: '项目管理员：管理 Project 成员、Tool Set、Memory、Agent',
  member: '成员：在 Project 内发起会话、调用已分配 Tool、确认写操作',
  approver: '审批人：审批高风险 Tool 调用',
}

/** 窗口解析已迁至 `@agenthub/analytics`；本文件只保留 KPI 映射所需的取整。 */

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function serviceOf<T>(value: T | undefined, service: string): T {
  if (value === undefined) {
    throw new AgenthubError('agenthub/ui/ServiceUnavailable', `${service} 服务未装配，接口暂不可用`, { httpStatus: 503 })
  }
  return value
}

// 错误响应统一走 AgenthubError（U5：router 的 catch 用 toErrorEnvelope 序列化为 {code,message,traceId}），
// 不再手写缺 `code` 的裸 envelope。
function notFound(): never {
  throw new AgenthubError('agenthub/ui/NotFound', 'not found', { httpStatus: 404 })
}

function methodNotAllowed(): never {
  throw new AgenthubError('agenthub/ui/MethodNotAllowed', 'method not allowed', { httpStatus: 405 })
}

function invalidRequest(message: string): never {
  throw new AgenthubError('agenthub/ui/InvalidRequest', message, { httpStatus: 400 })
}

/** 平台级管理视图读守卫（与写路径、SSR sessions/projects 同口径）：非 platform_admin → 403。 */
function requirePlatformAdmin(deps: JsonApiDeps, req: RouteRequest): void {
  const user = req.user
  deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
}

/**
 * /agenthub/api/* 阶段 D 路由分派（approvals 由 router 内部先行处理）。
 * 未知路径返回 404；装配缺失的服务抛 503（由 router 的 catch 转 U5 envelope）。
 */
export async function handleAgenthubApi(deps: JsonApiDeps, req: RouteRequest): Promise<RouteResult> {
  const user = req.user

  if (req.path === '/agenthub/api/tools') {
    if (req.method !== 'GET') return methodNotAllowed()
    requirePlatformAdmin(deps, req)
    const items = await listTools(serviceOf(deps.db, 'db'))
    return { status: 200, json: { items } }
  }

  if (req.path === '/agenthub/api/tools/enable-all') {
    if (req.method !== 'POST') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    return await enableAllTools(
      serviceOf(deps.db, 'db'),
      serviceOf(deps.connector, 'system-connector'),
      req,
    )
  }

  const toolEnabled = req.path.match(/^\/agenthub\/api\/tools\/([^/]+)\/enabled$/)
  if (toolEnabled !== null) {
    if (req.method !== 'POST') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    return await setToolEnabled(
      serviceOf(deps.db, 'db'),
      serviceOf(deps.connector, 'system-connector'),
      toolEnabled[1] ?? '',
      req,
    )
  }

  if (req.path === '/agenthub/api/connections') {
    if (req.method === 'GET') {
      requirePlatformAdmin(deps, req)
      const items = await listConnectionHealth(serviceOf(deps.db, 'db'), serviceOf(deps.connector, 'system-connector'))
      return { status: 200, json: { items } }
    }
    if (req.method === 'POST') {
      deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
      const connector = serviceOf(deps.connector, 'system-connector')
      const openapiUrl = req.form?.get('openapiUrl')?.trim() ?? ''
      const record = await connector.createConnection({
        userId: user.userId,
        projectId: req.form?.get('projectId') ?? '',
        name: req.form?.get('name') ?? '',
        baseUrl: req.form?.get('baseUrl') ?? '',
        frontendUrl: req.form?.get('frontendUrl') ?? '',
        openapiUrl: openapiUrl === '' ? null : openapiUrl,
      })
      if ((record.pendingHosts ?? []).length === 0 && deps.ingest !== undefined) {
        try {
          await deps.ingest.ingestFromUrl(record.id, { createdBy: user.userId })
        } catch (error) {
          if (!(error instanceof AgenthubError)) throw error
        }
      }
      return { status: 200, json: record }
    }
    return methodNotAllowed()
  }

  // 连接白名单：平台管理员按连接维护（C-4 的授权路径，前端可配而不是后端写死）。
  const connectionAllowlist = req.path.match(/^\/agenthub\/api\/connections\/([^/]+)\/allowlist$/)
  if (connectionAllowlist !== null) {
    if (req.method !== 'PUT') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    const id = connectionAllowlist[1] ?? ''
    if (!UUID_RE.test(id)) return notFound()
    const connector = serviceOf(deps.connector, 'system-connector')
    if (connector.updateConnection === undefined) {
      throw new AgenthubError('agenthub/ui/ServiceUnavailable', '连接服务不支持更新', { httpStatus: 503 })
    }
    const record = await connector.updateConnection(id, {
      allowedHosts: parseAllowedHosts(req.form?.get('allowedHosts')),
    })
    return { status: 200, json: record }
  }

  const connectionScan = req.path.match(/^\/agenthub\/api\/connections\/([^/]+)\/scan$/)
  if (connectionScan !== null) {
    if (req.method !== 'POST') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    const id = connectionScan[1] ?? ''
    if (!UUID_RE.test(id)) return notFound()
    const ingest = serviceOf(deps.ingest, 'openapi-ingest')
    const progress = deps.scanProgress
    if (progress !== undefined && progress.isRunning(id)) {
      // 同一连接不并发拉取同一份文档：已在跑就告知调用方去订阅进度。
      return { status: 409, json: { code: 'agenthub/ui/ScanInProgress', message: '该连接已有扫描在进行中' } }
    }
    if (progress === undefined) {
      // 未装配进度注册表：退回同步语义（保持既有调用方可用）。
      const receipt = await ingest.ingestFromUrl(id, { createdBy: user.userId })
      return { status: 200, json: receipt }
    }
    // 后台执行：立刻返回，让弹窗能订阅进度；关掉弹窗后任务照常跑完并留下状态。
    void ingest.ingestFromUrl(id, { createdBy: user.userId }).catch(() => {
      // 失败状态已由 ingestFromUrl 写入注册表；此处只吞掉未处理的 rejection。
    })
    return { status: 202, json: progress.get(id) ?? { connectionId: id, phase: 'fetching', processed: 0, total: null } }
  }

  // 扫描进度：弹窗轮询它。不是流式（RouteResult 不支持），但状态在服务端，刷新/重开仍在。
  const connectionItem = req.path.match(/^\/agenthub\/api\/connections\/([^/]+)$/)
  if (connectionItem !== null) {
    if (req.method !== 'DELETE') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    return await deleteConnection(
      serviceOf(deps.db, 'db'),
      serviceOf(deps.connector, 'system-connector'),
      connectionItem[1] ?? '',
    )
  }

  const connectionScanProgress = req.path.match(/^\/agenthub\/api\/connections\/([^/]+)\/scan\/progress$/)
  if (connectionScanProgress !== null) {
    if (req.method !== 'GET') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    const id = connectionScanProgress[1] ?? ''
    if (!UUID_RE.test(id)) return notFound()
    const progress = deps.scanProgress
    if (progress === undefined) return { status: 503, json: { code: 'agenthub/ui/ServiceUnavailable', message: '扫描进度不可用' } }
    return { status: 200, json: progress.get(id) ?? null }
  }

  if (req.path === '/agenthub/api/analytics') {
    if (req.method !== 'GET') return methodNotAllowed()
    requirePlatformAdmin(deps, req)
    // P5：指标计算由 @agenthub/analytics 提供；未装配 → 503（不再有内联回落）。
    const record = await getAnalytics(serviceOf(deps.analytics, 'analytics'), req.query.get('window'))
    return { status: 200, json: record }
  }

  if (req.path === '/agenthub/api/badcases') {
    if (req.method !== 'GET') return methodNotAllowed()
    requirePlatformAdmin(deps, req)
    const items = await listBadcases(serviceOf(deps.db, 'db'))
    return { status: 200, json: { items } }
  }

  if (req.path === '/agenthub/api/admin/users') {
    if (req.method !== 'GET') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    const items = await listUsers(serviceOf(deps.db, 'db'))
    return { status: 200, json: { items } }
  }

  if (req.path === '/agenthub/api/admin/roles') {
    if (req.method !== 'GET') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    const items = await listRoles(serviceOf(deps.db, 'db'))
    return { status: 200, json: { items } }
  }

  if (req.path === '/agenthub/api/projects') {
    if (req.method === 'GET') {
      const projects = await deps.project.listProjects(user.userId)
      const items: ProjectOption[] = projects.map(project => ({
        id: project.id,
        name: project.name,
        workspaceId: project.harnessWorkspaceId,
      }))
      return { status: 200, json: { items } }
    }
    if (req.method === 'POST') {
      // 与 SSR 的 POST /agenthub/projects 同口径：platform_admin 建 Project。
      deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
      const name = req.form?.get('name')?.trim() ?? ''
      if (name === '') invalidRequest('name 必填')
      const record = await deps.project.createProject({ userId: user.userId, name }, req.traceId)
      return { status: 200, json: { id: record.id, name: record.name, workspaceId: record.harnessWorkspaceId } }
    }
    return methodNotAllowed()
  }

  const projectTool = req.path.match(/^\/agenthub\/api\/projects\/([^/]+)\/tools\/([^/]+)$/)
  if (projectTool !== null) {
    if (req.method !== 'DELETE') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    return await deleteProjectTool(
      serviceOf(deps.db, 'db'),
      serviceOf(deps.connector, 'system-connector'),
      projectTool[1] ?? '',
      projectTool[2] ?? '',
    )
  }

  const projectItem = req.path.match(/^\/agenthub\/api\/projects\/([^/]+)$/)
  if (projectItem !== null) {
    if (req.method !== 'DELETE') return methodNotAllowed()
    deps.rbac.requirePlatformAdmin({ userId: user.userId, roles: user.roles }, req.traceId)
    return await deleteProject(
      serviceOf(deps.db, 'db'),
      serviceOf(deps.connector, 'system-connector'),
      projectItem[1] ?? '',
    )
  }

  const projectChat = req.path.match(/^\/agenthub\/api\/projects\/([^/]+)\/chat$/)
  if (projectChat !== null) {
    if (req.method !== 'POST') return methodNotAllowed()
    const projectId = projectChat[1] ?? ''
    if (!UUID_RE.test(projectId)) return notFound()
    const opened = await deps.project.prepareChatWorkspace(user.userId, asProjectId(projectId))
    deps.toolScope?.expectChat(projectId, user.userId)
    return { status: 200, json: opened }
  }

  if (req.path === '/agenthub/api/business-tools') {
    if (req.method !== 'GET') return methodNotAllowed()
    const items = await listBusinessToolNames(serviceOf(deps.db, 'db'), user.userId)
    return { status: 200, json: { items } }
  }

  if (req.path === '/agenthub/api/login-state') {
    if (req.method !== 'GET') return methodNotAllowed()
    return await readLoginState(deps, req)
  }

  const connectionLogin = req.path.match(/^\/agenthub\/api\/connections\/([^/]+)\/login$/)
  if (connectionLogin !== null) {
    if (req.method !== 'POST') return methodNotAllowed()
    const connectionId = connectionLogin[1] ?? ''
    if (!UUID_RE.test(connectionId)) return notFound()
    const startLogin = serviceOf(deps.connector, 'system-connector').startLogin
    if (startLogin === undefined) {
      throw new AgenthubError('agenthub/ui/ServiceUnavailable', '登录入口未装配', { httpStatus: 503 })
    }
    const url = await startLogin(user.userId, user.roles, connectionId)
    return { status: 200, json: { url } }
  }

  const credentials = req.path.match(/^\/agenthub\/api\/projects\/([^/]+)\/credentials$/)
  if (credentials !== null) {
    if (req.method !== 'POST') return methodNotAllowed()
    const projectId = credentials[1] ?? ''
    if (!UUID_RE.test(projectId)) return notFound()
    await deps.rbac.requireProjectAdmin({ userId: user.userId, roles: user.roles }, projectId, req.traceId)
    return await storeProjectCredential(serviceOf(deps.vault, 'vault'), user.userId, req)
  }

  const memoryList = req.path.match(/^\/agenthub\/api\/projects\/([^/]+)\/memories$/)
  if (memoryList !== null) {
    return await handleMemoryList(deps, req, memoryList[1] ?? '')
  }

  const memoryItem = req.path.match(/^\/agenthub\/api\/projects\/([^/]+)\/memories\/([^/]+)(?:\/(confirm|reject|lock|unlock))?$/)
  if (memoryItem !== null) {
    return await handleMemoryItem(deps, req, memoryItem[1] ?? '', memoryItem[2] ?? '', memoryItem[3])
  }

  if (req.path === '/agenthub/api/audit') {
    return await handleAuditList(deps, req)
  }

  const badcaseMark = req.path.match(/^\/agenthub\/api\/audit\/([^/]+)\/badcase$/)
  if (badcaseMark !== null) {
    return await handleBadcaseMark(deps, req, badcaseMark[1] ?? '')
  }

  const badcaseResolve = req.path.match(/^\/agenthub\/api\/badcases\/([^/]+)\/resolve$/)
  if (badcaseResolve !== null) {
    return await handleBadcaseResolve(deps, req, badcaseResolve[1] ?? '')
  }

  return notFound()
}

/**
 * 坏例写操作的返回面。
 *
 * 与列表 DTO（`BadcaseRecord`）不同：写操作不回表读 join，故不含项目名 / 用户名 /
 * 会话 / 工具——客户端登记后只用 `id` 与 `status` 更新本地行，其余字段由下一次
 * 列表刷新补齐。这样避免为一次写入额外查三张表。
 */
function badcaseWriteReceipt(row: BadcaseRowLike): {
  readonly id: string
  readonly auditId: string
  readonly cause: string
  readonly causeDetail: string
  readonly status: 'resolved' | 'open'
  readonly createdAt: string
} {
  return {
    id: row.id,
    auditId: row.audit_id,
    cause: row.category,
    causeDetail: row.category_note ?? '',
    status: row.resolved ? 'resolved' : 'open',
    createdAt: iso(row.created_at),
  }
}

/**
 * 把表单里的白名单文本解析成主机项。
 *
 * 接受换行、逗号或分号分隔，去空白与空项——用户不该为了填白名单去记分隔符。
 * 合法性（主机名形状）由服务层收敛，这里只做拆分。
 * @param raw - 表单原文；未提交时为 `undefined`。
 * @returns 主机项数组；未提交时为空数组（即默认全拒）。
 */
function parseAllowedHosts(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return []
  return raw.split(/[\n,;]+/).map(item => item.trim()).filter(item => item !== '')
}

/**
 * POST /agenthub/api/audit/:auditId/badcase · 登记坏例（P5 阶段书 §7.1-2）。
 *
 * 项目归属取自请求体（该审计记录所属项目），并经 `requireProjectMember`
 * 校验调用方是该项目成员，fail-closed。重复登记为幂等更新（服务层 upsert）。
 */
async function handleBadcaseMark(deps: JsonApiDeps, req: RouteRequest, auditId: string): Promise<RouteResult> {
  if (req.method !== 'POST') return methodNotAllowed()
  if (!UUID_RE.test(auditId)) return notFound()
  const projectId = req.form?.get('projectId')?.trim() ?? ''
  if (projectId === '') invalidRequest('projectId 必填')
  if (!UUID_RE.test(projectId)) return notFound()
  const category = req.form?.get('category')?.trim() ?? ''
  if (!(BADCASE_CAUSES as readonly string[]).includes(category)) {
    invalidRequest(`category 必须为 ${BADCASE_CAUSES.join(' / ')}`)
  }
  await deps.rbac.requireProjectMember({ userId: req.user.userId, roles: req.user.roles }, projectId, req.traceId)

  const note = req.form?.get('note')?.trim() ?? ''
  const row = await serviceOf(deps.audit, 'audit').markBadcase({
    auditId,
    projectId,
    category: category as BadcaseCause,
    note: note === '' ? null : note,
    markedBy: req.user.userId,
  })
  return { status: 200, json: badcaseWriteReceipt(row) }
}

/**
 * POST /agenthub/api/badcases/:id/resolve · 坏例销号（P5 阶段书 §7.1-2）。
 *
 * 归属项目由**服务端反查**（客户端只知道坏例 id），随后按 `requireProjectMember`
 * 校验成员身份；未命中（不存在、无项目、跨项目）一律 404，不泄漏他项目坏例存在性。
 */
async function handleBadcaseResolve(deps: JsonApiDeps, req: RouteRequest, badcaseId: string): Promise<RouteResult> {
  if (req.method !== 'POST') return methodNotAllowed()
  if (!UUID_RE.test(badcaseId)) return notFound()
  const audit = serviceOf(deps.audit, 'audit')
  const projectId = await audit.findBadcaseProject(badcaseId)
  if (projectId === null) return notFound()
  await deps.rbac.requireProjectMember({ userId: req.user.userId, roles: req.user.roles }, projectId, req.traceId)

  const row = await audit.resolveBadcase(badcaseId, projectId, req.user.userId)
  if (row === null) return notFound()
  return { status: 200, json: badcaseWriteReceipt(row) }
}

/**
 * GET /agenthub/api/audit · 审计查询（阶段 C3-B）。
 *
 * `projectId` **必填**：没有"全部项目"这个入口，跨项目查询面不存在（`BND-4`）。
 * 经 `requireProjectMember` 校验调用方是该 Project 成员，fail-closed。
 */
async function handleAuditList(deps: JsonApiDeps, req: RouteRequest): Promise<RouteResult> {
  if (req.method !== 'GET') return methodNotAllowed()
  const projectId = req.query.get('projectId') ?? ''
  if (projectId === '') invalidRequest('projectId 必填')
  if (!UUID_RE.test(projectId)) return notFound()
  await deps.rbac.requireProjectMember({ userId: req.user.userId, roles: req.user.roles }, projectId, req.traceId)
  const audit = serviceOf(deps.audit, 'audit')

  const status = req.query.get('status')
  if (status !== null && !(AUDIT_STATUSES as readonly string[]).includes(status)) {
    // 非法枚举不得静默当默认：页面会以为筛过了，实际拿到全集。
    invalidRequest(`status 必须为 ${AUDIT_STATUSES.join(' / ')}`)
  }
  const limit = parseIntParam(req.query.get('limit'), AUDIT_DEFAULT_LIMIT, 1, AUDIT_MAX_LIMIT)
  const offset = parseIntParam(req.query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const page = await audit.listRecords({
    projectId,
    ...optionalFilter('userId', req.query.get('userId')),
    ...optionalFilter('toolId', req.query.get('toolId')),
    ...(status === null ? {} : { status: status as AuditStatus }),
    ...optionalFilter('from', req.query.get('from')),
    ...optionalFilter('to', req.query.get('to')),
    limit,
    offset,
  })
  return {
    status: 200,
    json: {
      total: page.total,
      items: page.items.map(row => ({
        id: row.id,
        projectId: row.project_id,
        userId: row.user_id,
        sessionId: row.session_id,
        toolId: row.tool_id,
        toolName: row.tool_name,
        risk: row.risk_level,
        status: row.status,
        traceId: row.trace_id,
        createdAt: iso(row.created_at),
      })),
    },
  }
}

/** 仅在参数存在时携带该筛选键（exactOptionalPropertyTypes：不传 undefined）。 */
function optionalFilter<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value === null || value === '' ? {} : { [key]: value } as Partial<Record<K, string>>
}

/**
 * 解析分页整数参数。
 * @throws AgenthubError 400 非法（越界或非整数不得当默认，否则分页静默错位）。
 */
function parseIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    invalidRequest(`分页参数必须是 ${String(min)}–${String(max)} 之间的整数`)
  }
  return value
}

/**
 * 记忆路由的成员级守卫（`BND-4`：只能操作自己所属 Project 的记忆）。
 *
 * 用成员级而非管理员级：记忆确认是普通成员的日常工作，Project 管理员角色过严。
 * @throws AgenthubError `agenthub/rbac/Forbidden`（403）非成员。
 */
async function requireMemoryAccess(deps: JsonApiDeps, req: RouteRequest, projectId: string): Promise<void> {
  await deps.rbac.requireProjectMember({ userId: req.user.userId, roles: req.user.roles }, projectId, req.traceId)
}

/**
 * 记忆行 → 客户端契约（camelCase）。
 * @param row - 记忆服务返回的一行（含全部契约字段）。
 * @param sourceSessionId - 候选来源会话（服务面未暴露时缺省 null）。
 * @returns 客户端可直接消费的记忆记录。
 */
function toMemoryRecord(
  row: {
    id: string
    projectId: string
    content: string
    status: 'candidate' | 'active'
    locked: boolean
    deleted: boolean
    createdAt: string
    updatedAt: string
  },
  sourceSessionId: string | null = null,
): MemoryRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    content: row.content,
    status: row.status,
    locked: row.locked,
    deleted: row.deleted,
    sourceSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
/** GET /agenthub/api/projects/:id/memories[?status=candidate|active]。 */
async function handleMemoryList(deps: JsonApiDeps, req: RouteRequest, projectId: string): Promise<RouteResult> {
  if (req.method !== 'GET') return methodNotAllowed()
  if (!UUID_RE.test(projectId)) return notFound()
  await requireMemoryAccess(deps, req, projectId)
  const memory = serviceOf(deps.memory, 'project-memory')

  const scope = req.query.get('status')
  if (scope !== null && scope !== 'candidate' && scope !== 'active') {
    // 非法枚举不得静默当默认：它会让调用方以为筛过，实际拿到全集。
    invalidRequest('status 必须为 candidate 或 active')
  }
  const rows = scope === 'candidate'
    ? await memory.listCandidates(projectId)
    : await memory.listMemories(projectId, scope === 'active' ? { scope: 'active' } : {})
  return { status: 200, json: { items: rows.map(row => toMemoryRecord(row)) } }
}

/** 列表之外的记忆子路径：`/:mid`（DELETE）、`/:mid/confirm|reject|lock|unlock`（POST）。 */
async function handleMemoryItem(
  deps: JsonApiDeps,
  req: RouteRequest,
  projectId: string,
  memoryId: string,
  action: string | undefined,
): Promise<RouteResult> {
  if (!UUID_RE.test(projectId) || !UUID_RE.test(memoryId)) return notFound()
  await requireMemoryAccess(deps, req, projectId)
  const memory = serviceOf(deps.memory, 'project-memory')

  if (action === undefined) {
    // 删除双轨：默认软删（可回溯），`?hard=true` 才物理删（不可恢复）。
    if (req.method !== 'DELETE') return methodNotAllowed()
    const hard = req.query.get('hard') === 'true'
    const deleted = hard
      ? await memory.hardDelete(memoryId, projectId)
      : await memory.softDelete(memoryId, projectId)
    if (!deleted) return memoryNotFound()
    return { status: 200, json: { id: memoryId, hard } }
  }

  if (req.method !== 'POST') return methodNotAllowed()
  switch (action) {
    case 'confirm': {
      const row = await memory.confirmCandidate(memoryId, projectId)
      if (row === null) return memoryNotFound()
      return { status: 200, json: toMemoryRecord(row) }
    }
    case 'reject': {
      const rejected = await memory.rejectCandidate(memoryId, projectId)
      if (!rejected) return memoryNotFound()
      return { status: 200, json: { id: memoryId, rejected } }
    }
    case 'lock':
    case 'unlock': {
      const row = await memory.setLocked(memoryId, action === 'lock', projectId)
      if (row === null) return memoryNotFound()
      return { status: 200, json: toMemoryRecord(row) }
    }
    default:
      return notFound()
  }
}

/** 记忆不存在或不属于该 Project（D33：归属不匹配与不存在同码，避免探测他项目 id）。 */
function memoryNotFound(): never {
  throw new AgenthubError('agenthub/ui/MemoryNotFound', '记忆不存在或不属于该 Project', { httpStatus: 404 })
}

/** 当前员工所属项目里、挂了系统连接的工具名。对话据此给这些工具挂登录卡片。 */
async function listBusinessToolNames(db: Queryable, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    'SELECT DISTINCT t.name FROM tools t'
    + ' JOIN system_connections c ON c.id = t.system_connection_id'
    + ' JOIN projects p ON p.system_connection_id = c.id'
    + ' JOIN project_members pm ON pm.project_id = p.id'
    + " JOIN users u ON u.id = pm.user_id AND u.status = 'active'"
    + ' WHERE pm.user_id = $1 ORDER BY t.name',
    [userId],
  )
  return rows.map(row => row.name)
}

/**
 * 当前会话所在项目 + 工具所属连接的登录状态。
 * 解析不出项目、不是成员、或工具不属于该项目 → 与不存在同码（BND-4）。
 */
async function readLoginState(deps: JsonApiDeps, req: RouteRequest): Promise<RouteResult> {
  const tool = req.query.get('tool')?.trim() ?? ''
  const cwd = req.query.get('cwd')?.trim() ?? ''
  if (tool === '' || cwd === '') invalidRequest('tool 与 cwd 必填')
  const workspaces = serviceOf(deps.workspaces, 'workspaceRegistry')
  const vault = serviceOf(deps.vault, 'vault')
  if (vault.credentialStatus === undefined) {
    throw new AgenthubError('agenthub/ui/ServiceUnavailable', '凭证状态查询未装配', { httpStatus: 503 })
  }
  const workspace = await workspaces.resolveByPath(cwd)
  if (workspace === undefined) return notFound()
  const project = await deps.project.findByWorkspaceId(asWorkspaceId(String(workspace.id)))
  if (project === null) return notFound()
  await deps.project.resolveProjectContext(req.user.userId, asProjectId(project.id))
  const { rows } = await serviceOf(deps.db, 'db').query<{ id: string; name: string }>(
    'SELECT c.id, c.name FROM tools t'
    + ' JOIN system_connections c ON c.id = t.system_connection_id'
    + ' JOIN projects p ON p.system_connection_id = c.id'
    + ' WHERE t.name = $1 AND p.id = $2',
    [tool, project.id],
  )
  const connection = rows[0]
  if (connection === undefined) return notFound()
  const status = await vault.credentialStatus(req.user.userId, connection.id)
  return {
    status: 200,
    json: { connectionId: connection.id, connectionName: connection.name, status },
  }
}

/** tools 读取：显式列名 + 连接名 + 已分配 Project 集合（LEFT JOIN / 关联子查询，无 N+1）。 */
async function listTools(db: Queryable): Promise<ToolRecord[]> {
  const { rows } = await db.query<ToolRow>(
    'SELECT t.id, t.name, t.description, t.parameters, t.source, t.source_ref, t.risk_level,'
    + ' t.requires_approval, t.enabled, sc.name AS connection_name,'
    + ' COALESCE((SELECT array_agg(pts.project_id::text) FROM project_tool_set pts WHERE pts.tool_id = t.id),'
    + ' ARRAY[]::text[]) AS project_ids'
    + ' FROM tools t LEFT JOIN system_connections sc ON sc.id = t.system_connection_id'
    + ' ORDER BY t.name',
    [],
  )
  return rows.map((row) => {
    const { method, path } = splitSourceRef(row.source_ref)
    const status: ToolStatus = row.enabled ? 'enabled' : row.source === 'openapi' ? 'draft' : 'disabled'
    return {
      id: row.id,
      name: row.name,
      api: row.name,
      method,
      path,
      source: row.connection_name ?? 'manual',
      risk: row.risk_level,
      approval: row.requires_approval,
      status,
      usedBy: row.project_ids ?? [],
      desc: row.description,
      params: row.parameters === null || row.parameters === undefined ? '{}' : JSON.stringify(row.parameters),
      result: '',
    }
  })
}

/** source_ref 形如 `"GET /x/{id}"` → {method,path}；否则两者均 ''。 */
function splitSourceRef(ref: string | null): { method: string; path: string } {
  const trimmed = ref?.trim() ?? ''
  const space = trimmed.indexOf(' ')
  if (trimmed === '' || space <= 0) return { method: '', path: '' }
  return { method: trimmed.slice(0, space), path: trimmed.slice(space + 1).trim() }
}

/**
 * Tool 启停（platform_admin）：UPDATE 0 行 → 404。
 * C-5：UPDATE 成功后触发 connector Tool 重载（按当前 enabled 重注册），无需重启即生效。
 */
async function setToolEnabled(db: Queryable, connector: ConnectorLike, id: string, req: RouteRequest): Promise<RouteResult> {
  if (!UUID_RE.test(id)) return notFound()
  const raw = req.form?.get('enabled')
  if (raw !== 'true' && raw !== 'false') return invalidRequest('enabled 必须为 true 或 false')
  const { rows } = await db.query<{ id: string }>(
    'UPDATE tools SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING id',
    [id, raw === 'true'],
  )
  if (rows.length === 0) {
    throw new AgenthubError('agenthub/ui/ToolNotFound', 'Tool 不存在', { httpStatus: 404 })
  }
  await connector.reloadTools?.()
  return { status: 200, json: { ok: true } }
}

/**
 * 启用一个 Project 里尚未启用的全部 Tool。
 * 同一条 UPDATE 用 project_tool_set 约束归属（BND-4），其他 Project 的行不受影响。
 * 有行变更时才重载 connector，避免空操作也重建注册。
 */
async function enableAllTools(db: Queryable, connector: ConnectorLike, req: RouteRequest): Promise<RouteResult> {
  const projectId = req.form?.get('projectId')?.trim() ?? ''
  if (!UUID_RE.test(projectId)) return invalidRequest('projectId 必须为 UUID')
  const { rows } = await db.query<{ id: string }>(
    'UPDATE tools AS t SET enabled = true, updated_at = now()'
    + ' WHERE t.enabled = false AND EXISTS ('
    + ' SELECT 1 FROM project_tool_set pts WHERE pts.tool_id = t.id AND pts.project_id = $1'
    + ') RETURNING t.id',
    [projectId],
  )
  if (rows.length > 0) await connector.reloadTools?.()
  return { status: 200, json: { ok: true, updated: rows.length } }
}

/**
 * 删除一个 Project 里的一条 Tool。
 * 同一条 DELETE 同时约束 tool id 与 project_tool_set 归属（BND-4）。
 */
async function deleteProjectTool(
  db: Queryable,
  connector: ConnectorLike,
  projectId: string,
  toolId: string,
): Promise<RouteResult> {
  if (!UUID_RE.test(projectId) || !UUID_RE.test(toolId)) return notFound()
  const { rows } = await db.query<{ id: string }>(
    'DELETE FROM tools AS t WHERE t.id = $1 AND EXISTS ('
    + ' SELECT 1 FROM project_tool_set pts WHERE pts.tool_id = t.id AND pts.project_id = $2'
    + ') RETURNING t.id',
    [toolId, projectId],
  )
  if (rows.length === 0) {
    throw new AgenthubError('agenthub/ui/ToolNotFound', 'Tool 不存在或不属于该 Project', { httpStatus: 404 })
  }
  await connector.reloadTools?.()
  return { status: 200, json: { id: toolId } }
}

/**
 * 删除系统连接，并先清掉挂在这条连接上的 Tool。
 * 凭证随连接的外键级联删除；项目上的连接指针由外键置空。
 */
async function deleteConnection(db: Queryable, connector: ConnectorLike, id: string): Promise<RouteResult> {
  if (!UUID_RE.test(id)) return notFound()
  await db.query<{ id: string }>(
    'DELETE FROM tools WHERE system_connection_id = $1 RETURNING id',
    [id],
  )
  const { rows } = await db.query<{ id: string }>(
    'DELETE FROM system_connections WHERE id = $1 RETURNING id',
    [id],
  )
  if (rows.length === 0) {
    throw new AgenthubError('agenthub/ui/ConnectionNotFound', '系统连接不存在', { httpStatus: 404 })
  }
  await connector.reloadTools?.()
  return { status: 200, json: { id } }
}

/**
 * 删除 Project：先清掉它这条连接上的 Tool、只属于它的 Tool，再删连接和项目本身。
 * 成员、记忆、审批随项目外键级联；其他项目仍在用的 Tool 留着。
 */
async function deleteProject(db: Queryable, connector: ConnectorLike, projectId: string): Promise<RouteResult> {
  if (!UUID_RE.test(projectId)) return notFound()
  await db.query<{ id: string }>(
    'DELETE FROM tools AS t WHERE t.system_connection_id IS NOT NULL'
    + ' AND t.system_connection_id = (SELECT p.system_connection_id FROM projects p WHERE p.id = $1)'
    + ' RETURNING t.id',
    [projectId],
  )
  await db.query<{ id: string }>(
    'DELETE FROM tools AS t WHERE EXISTS ('
    + ' SELECT 1 FROM project_tool_set pts WHERE pts.tool_id = t.id AND pts.project_id = $1'
    + ') AND NOT EXISTS ('
    + ' SELECT 1 FROM project_tool_set other WHERE other.tool_id = t.id AND other.project_id <> $1'
    + ') RETURNING t.id',
    [projectId],
  )
  await db.query<{ id: string }>(
    'DELETE FROM system_connections AS sc'
    + ' WHERE sc.id = (SELECT p.system_connection_id FROM projects p WHERE p.id = $1)'
    + ' RETURNING sc.id',
    [projectId],
  )
  const { rows } = await db.query<{ id: string }>(
    'DELETE FROM projects WHERE id = $1 RETURNING id',
    [projectId],
  )
  if (rows.length === 0) {
    throw new AgenthubError('agenthub/ui/ProjectNotFound', 'Project 不存在', { httpStatus: 404 })
  }
  await connector.reloadTools?.()
  return { status: 200, json: { id: projectId } }
}

/** 连接健康：派生自连接元数据 + 该连接下 tools 行数（真聚合，非编造）。 */
async function listConnectionHealth(db: Queryable, connector: ConnectorLike): Promise<ConnectionHealthRecord[]> {
  const connections = await connector.listConnections()
  const { rows: counts } = await db.query<{ system_connection_id: string; tool_count: number }>(
    'SELECT system_connection_id, COUNT(*)::int AS tool_count FROM tools'
    + ' WHERE system_connection_id IS NOT NULL GROUP BY system_connection_id',
    [],
  )
  const countByConnection = new Map(counts.map(row => [row.system_connection_id, row.tool_count]))
  return connections.map((connection) => {
    const tools = countByConnection.get(connection.id) ?? 0
    return {
      id: connection.id,
      name: connection.name,
      baseUrl: connection.baseUrl,
      frontendUrl: connection.frontendUrl ?? connection.baseUrl,
      projectId: connection.projectId ?? null,
      pendingHosts: connection.pendingHosts ?? [],
      type: connection.openapiUrl !== null && connection.openapiUrl !== '' ? 'openapi' : 'manual',
      auth: connection.authMode,
      status: tools > 0 ? 'healthy' : 'degraded',
      tools,
      lastCheck: connection.updatedAt,
      allowedHosts: connection.allowedHosts ?? [],
    }
  })
}

/** window 参数：`<n>d`（正整数）→ n 天；缺省/非法 → 14。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 环比百分数（整数）：两窗相等/均 0 → null（持平）；前窗 0 且有当前值 → 100（+100%）。 */
function formatDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? null : 100
  const pct = Math.round(((current - previous) / previous) * 100)
  return pct === 0 ? null : pct
}

/**
 * 运营分析：委托 `@agenthub/analytics`（P5）聚合并映射为本路由的既有契约。
 *
 * 指标计算已迁至 analytics 包；本函数只做**形状映射**，保持 `AnalyticsRecord`
 * 不变（既有 UI 与测试依赖该契约）。全部无数据 → KPI 全 0、deltas 全 null、
 * toolTrend 全 0、failCauses/topTools 为空。
 */
async function getAnalytics(analytics: AnalyticsLike, rawWindow: string | null): Promise<AnalyticsRecord> {
  const snapshot = await analytics.aggregate(rawWindow)

  const total = snapshot.toolCalls
  const successRate = round1(snapshot.successRate)
  const badcaseRate = total === 0 ? 0 : round1((snapshot.badcaseTotal / total) * 100)
  const approvalRate = total === 0 ? 0 : round1((snapshot.approvals / total) * 100)

  const prevTotal = snapshot.previous.toolCalls
  const prevBadcaseRate = prevTotal === 0 ? 0 : round1((snapshot.previous.badcaseTotal / prevTotal) * 100)
  const prevApprovalRate = prevTotal === 0 ? 0 : round1((snapshot.previousApprovals / prevTotal) * 100)

  return {
    kpi: {
      dau: snapshot.activeUsers,
      sessions: snapshot.sessions,
      toolCalls: total,
      successRate,
      badcaseRate,
      approvalRate,
    },
    deltas: {
      dau: formatDelta(snapshot.activeUsers, snapshot.previous.activeUsers),
      sessions: formatDelta(snapshot.sessions, snapshot.previous.sessions),
      toolCalls: formatDelta(total, prevTotal),
      successRate: formatDelta(successRate, round1(snapshot.previous.successRate)),
      badcaseRate: formatDelta(badcaseRate, prevBadcaseRate),
      approvalRate: formatDelta(approvalRate, prevApprovalRate),
    },
    toolTrend: snapshot.toolTrend,
    failCauses: snapshot.badcaseDistribution.map(row => ({ cause: row.cause as BadcaseCause, count: row.count })),
    topTools: snapshot.topTools.map(row => ({ api: row.api, count: row.count })),
  }
}

/** 坏例列表：badcases → audit_records → projects/users 真 join（无问答存储列，留空/摘要）。 */
async function listBadcases(db: Queryable): Promise<BadcaseRecord[]> {
  const { rows } = await db.query<BadcaseRow>(
    'SELECT b.id, b.created_at, b.category, b.category_note, b.ai_summary, b.resolved,'
    + ' p.name AS project_name, u.display_name AS user_name,'
    + ' a.session_id AS session_id, a.tool_name AS tool_name'
    + ' FROM badcases b'
    + ' LEFT JOIN audit_records a ON a.id = b.audit_id'
    + ' LEFT JOIN projects p ON p.id = a.project_id'
    + ' LEFT JOIN users u ON u.id = a.user_id'
    + ' ORDER BY b.created_at DESC',
    [],
  )
  return rows.map(row => ({
    id: row.id,
    question: row.ai_summary ?? '',
    answer: row.ai_summary ?? '',
    cause: row.category as BadcaseCause,
    causeDetail: row.category_note ?? '',
    project: row.project_name ?? '',
    user: row.user_name ?? '',
    status: row.resolved ? 'resolved' : 'open',
    createdAt: iso(row.created_at),
    session: row.session_id ?? '',
    tool: row.tool_name ?? '',
  }))
}

/** 平台用户列表（platform_admin）：roles.name 聚合后用 '、' 连接并映射显示名。 */
async function listUsers(db: Queryable): Promise<UserRecord[]> {
  const { rows } = await db.query<{
    id: string
    display_name: string
    email: string
    status: string
    role_names: string
  }>(
    'SELECT u.id, u.display_name, u.email, u.status,'
    + " COALESCE((SELECT string_agg(r.name, '、' ORDER BY r.name) FROM user_roles ur"
    + ' JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), \'\') AS role_names'
    + ' FROM users u ORDER BY u.email',
    [],
  )
  return rows.map(row => ({
    id: row.id,
    name: row.display_name,
    email: row.email,
    role: row.role_names
      .split('、')
      .filter(name => name !== '')
      .map(name => ROLE_DISPLAY[name] ?? name)
      .join('、'),
    active: row.status === 'active',
  }))
}

/** 平台角色列表（platform_admin）：desc 静态映射，members 为 user_roles 计数。 */
async function listRoles(db: Queryable): Promise<RoleRecord[]> {
  const { rows } = await db.query<{ name: string; member_count: number }>(
    'SELECT r.name, (SELECT COUNT(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS member_count'
    + ' FROM roles r ORDER BY r.name',
    [],
  )
  return rows.map(row => ({
    name: row.name,
    desc: ROLE_DESC[row.name] ?? '',
    members: row.member_count,
    builtin: true,
  }))
}

/** Project 凭证写入（该 Project 的 admin）：绝不回显明文。 */
async function storeProjectCredential(vault: VaultLike, userId: string, req: RouteRequest): Promise<RouteResult> {
  const systemConnectionId = req.form?.get('systemConnectionId')?.trim() ?? ''
  const plaintext = req.form?.get('plaintext') ?? ''
  if (systemConnectionId === '' || plaintext === '') {
    return invalidRequest('systemConnectionId 与 plaintext 必填')
  }
  const externalUserId = req.form?.get('externalUserId')?.trim() ?? ''
  const expiresAt = req.form?.get('expiresAt')?.trim() ?? ''
  const stored = await vault.storeCredential({
    userId,
    systemConnectionId,
    plaintext,
    externalUserId: externalUserId === '' ? null : externalUserId,
    expiresAt: expiresAt === '' ? null : expiresAt,
  })
  return { status: 200, json: { id: stored.id, keyVersion: stored.keyVersion, expiresAt: stored.expiresAt } }
}

/** tools 行（显式列名读取）。 */
interface ToolRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly source: string
  readonly source_ref: string | null
  readonly risk_level: ToolRisk
  readonly requires_approval: boolean
  readonly enabled: boolean
  readonly connection_name: string | null
  readonly project_ids: string[] | null
}

/** badcases 列表行（join 后的领域视图）。 */
interface BadcaseRow {
  readonly id: string
  readonly created_at: Date | string
  readonly category: string
  readonly category_note: string | null
  readonly ai_summary: string | null
  readonly resolved: boolean
  readonly project_name: string | null
  readonly user_name: string | null
  readonly session_id: string | null
  readonly tool_name: string | null
}
