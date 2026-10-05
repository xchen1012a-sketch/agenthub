/**
 * Module data seam: every console module page reads through this interface.
 * The current implementation is `mockApi` (原型 data.js, enums per
 * docs/api-contracts.md); from P3 on each method's body swaps to
 * `fetch('/agenthub/api/...')` with the signature untouched — pages and the
 * mock layer stay put. Field names follow the contract table; identity always
 * comes from the server session (A6), so no method takes a userId.
 */

// The two P3-gap methods below alias the prototype fixtures; see the httpApi note.
import { mockApi } from './mock/data.ts'

/** Tool risk grading (contract: tools.risk_level; DB 0007 read/write/sensitive/critical). */
export type ToolRisk = 'read' | 'write' | 'sensitive' | 'critical'

/** Tool lifecycle status (server `ToolRecord.status`: enabled/draft/disabled). */
export type ToolStatus = 'enabled' | 'draft' | 'disabled'

/** Approval decision status (contract: approvals.status). */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** External system connection health (server `ConnectionHealthRecord.status`: healthy/degraded). */
export type ConnectionStatus = 'healthy' | 'degraded'

/** Connection ingest type (server `ConnectionHealthRecord.type`: openapi/manual). */
export type ConnectionType = 'openapi' | 'manual'

/** Badcase triage status (server `BadcaseRecord.status`: open/resolved). */
export type BadcaseStatus = 'open' | 'resolved'

/** Badcase attribution (contract: badcases.category, DB 0012 eight-value domain). */
export type BadcaseCause =
  | 'wrong_tool'
  | 'bad_param'
  | 'upstream_error'
  | 'permission_denied'
  | 'model_misunderstanding'
  | 'prompt_injection'
  | 'timeout'
  | 'unknown'

/** One Global Tool Registry row (future: GET /agenthub/api/tools). */
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

/** One approval decision row (future: GET /agenthub/api/approvals). */
export interface ApprovalRecord {
  readonly id: string
  readonly user: string
  readonly project: string
  readonly toolName: string
  readonly toolLabel: string
  readonly risk: ToolRisk
  readonly detail: string
  readonly createdAt: string
  readonly status: ApprovalStatus
}

/** One badcase row (future: GET /agenthub/api/badcases). */
export interface BadcaseRecord {
  readonly id: string
  readonly question: string
  readonly answer: string
  readonly cause: BadcaseCause
  readonly causeDetail: string
  readonly project: string
  readonly user: string
  readonly status: BadcaseStatus
  readonly createdAt: string
  /** Origin session title and tool name for the trace line ('—' when no tool ran). */
  readonly session: string
  readonly tool: string
}

/** One project the current employee can enter (id, display name, its conversation space). */
export interface ProjectOption {
  readonly id: string
  readonly name: string
  readonly workspaceId: string
}

/** One connection row (future: GET /agenthub/api/connections). */
export interface ConnectionHealthRecord {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly frontendUrl: string
  readonly projectId: string | null
  readonly pendingHosts: readonly string[]
  readonly type: ConnectionType
  readonly auth: string
  readonly status: ConnectionStatus
  readonly tools: number
  readonly lastCheck: string
  /** 出站目标白名单（C-4 授权路径）；空数组 = 受限地址全拒。 */
  readonly allowedHosts: readonly string[]
}

/** 对话登录卡片用的连接状态（不含凭证）。 */
export interface LoginState {
  readonly connectionId: string
  readonly connectionName: string
  readonly status: 'missing' | 'expired' | 'ready'
}

/** The row the server returns after a create (POST /agenthub/api/connections → system_connections). */
export interface ScanProgressRecord {
  readonly phase: 'fetching' | 'parsing' | 'grading' | 'writing' | 'done' | 'failed'
  readonly processed: number
  readonly total: number | null
  readonly reason?: string
  readonly created?: number
  readonly skipped?: number
  readonly startedAt: string
  readonly finishedAt?: string
}

/** 同步扫描完成时 POST /scan 返回的入库摘要（202 异步启动时不返回此形状）。 */
export interface ScanReceipt {
  readonly created: readonly string[]
  readonly skipped: readonly { name: string; sourceRef: string; reason: string }[]
  readonly total: number
}

export interface CreatedConnection {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly authMode: string
  readonly openapiUrl: string | null
  readonly hasOpenapiDoc: boolean
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One async task row (placeholder mock; the tasks module has no backend owner yet — contract backfill pending). */
export interface TaskRecord {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly status: 'running' | 'queued' | 'done' | 'failed'
  readonly createdAt: string
}

/** One platform user row (future: GET /agenthub/api/admin/users). */
export interface UserRecord {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly role: string
  readonly active: boolean
}

/** One platform role row (future: GET /agenthub/api/admin/roles). */
export interface RoleRecord {
  readonly name: string
  readonly desc: string
  readonly members: number
  readonly builtin: boolean
}

/** AI operations KPI block (future: GET /agenthub/api/analytics?window=14d). */
export interface AnalyticsKpi {
  readonly dau: number
  readonly sessions: number
  readonly toolCalls: number
  readonly successRate: number
  readonly badcaseRate: number
  readonly approvalRate: number
}

/** AI operations snapshot: KPI + trend + rankings over one time window. */
export interface AnalyticsRecord {
  readonly kpi: AnalyticsKpi
  /** Signed percent change per KPI (integer); null = flat. The view renders it via i18n (U4). */
  readonly deltas: {
    readonly dau: number | null
    readonly sessions: number | null
    readonly toolCalls: number | null
    readonly successRate: number | null
    readonly badcaseRate: number | null
    readonly approvalRate: number | null
  }
  /** Daily tool-call totals, oldest first (14 days). */
  readonly toolTrend: readonly number[]
  readonly failCauses: readonly { readonly cause: BadcaseCause; readonly count: number }[]
  readonly topTools: readonly { readonly api: string; readonly count: number }[]
}

/** The agent bound to the demo project (prototype project settings · Agent tab). */
export interface ProjectAgentProfile {
  readonly name: string
  readonly model: string
  readonly desc: string
  readonly approval: string
  readonly memory: string
  readonly skills: readonly string[]
  readonly mcp: readonly string[]
}

/**
 * Agent tab placeholder for projects without a backend-owned Agent profile.
 * No backend package owns the Agent profile yet, so the settings view renders
 * this constant rather than inventing a per-project fake (one shape, one owner).
 * Replace it when a backend owner lands.
 */
const AGENT_TAB_PLACEHOLDER: ProjectAgentProfile = {
  name: '-',
  model: '-',
  desc: '',
  approval: '-',
  memory: '-',
  skills: [],
  mcp: [],
}

/** One registry tool offered to the project's Tool Set tab. */
export interface ProjectToolOption {
  readonly id: string
  readonly name: string
  readonly api: string
  readonly risk: ToolRisk
}

/**
 * One project memory entry (real contract; GET `/agenthub/api/projects/:id/memories`).
 *
 * `status='candidate'` entries are extracted at session end and await human
 * confirmation; they are NOT injected into prompts until confirmed. `deleted`
 * marks a soft delete (row retained, hidden from injection and lists).
 */
export interface ProjectMemoryRecord {
  readonly id: string
  readonly projectId: string
  readonly content: string
  readonly status: 'candidate' | 'active'
  readonly locked: boolean
  readonly deleted: boolean
  readonly sourceSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One project file entry (prototype project settings · Files tab). */
export interface ProjectFileItem {
  readonly id: string
  readonly name: string
  readonly size: string
  readonly inCtx: boolean
  readonly updated: string
}

/** One project member row (prototype project settings · Members tab). */
export interface ProjectMemberItem {
  readonly name: string
  readonly role: string
  readonly email: string
  readonly joined: string
}

/** The demo project's settings snapshot across the five prototype tabs. */
export interface ProjectSettingsRecord {
  /** Project id; settings are per-project isolated. */
  readonly id: string
  readonly name: string
  readonly system: string
  readonly agent: ProjectAgentProfile
  /** Registry ids assigned to this project's Tool Set (fail-closed allowlist). */
  readonly toolSet: readonly string[]
  readonly toolOptions: readonly ProjectToolOption[]
  /** Confirmed memories (injected into new sessions). */
  readonly memories: readonly ProjectMemoryRecord[]
  /** Confirm memories in a list are NOT injected until confirmed; candidates await review. */
  readonly memoryCandidates: readonly ProjectMemoryRecord[]
  readonly files: readonly ProjectFileItem[]
  readonly members: readonly ProjectMemberItem[]
}

/**
 * The module data seam every console page consumes. Project settings are
 * per-project isolated: every record is one project's own snapshot, keyed by
 * project id — pages switch projects explicitly until the workspace tree
 * carries the selection natively.
 */
/**
 * One audit record row (GET `/agenthub/api/audit`).
 *
 * `projectId` is nullable because `audit_records.project_id` is `ON DELETE SET
 * NULL` — audit rows outlive the project they belong to.
 */
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

/** `audit_records.status` 四枚举（细分原因在 `result_meta.reason`）。 */
export type AuditStatus = 'ok' | 'error' | 'denied' | 'pending'

/**
 * Audit query. `projectId` is required: the query surface always carries project
 * ownership, so there is no "all projects" entry (BND-4).
 */
export interface AuditQuery {
  readonly projectId: string
  readonly userId?: string
  readonly toolId?: string
  readonly status?: AuditStatus
  readonly limit?: number
  readonly offset?: number
}

/** One page of audit records plus the total under the same filter. */
export interface AuditPage {
  readonly items: readonly AuditRecord[]
  readonly total: number
}

export interface AgenthubApi {
  listTools(): Promise<readonly ToolRecord[]>
  listProjectOptions(): Promise<readonly ProjectOption[]>
  /**
   * Attach this project's workspace to the conversation list and return the
   * path the client must adopt before opening a session.
   */
  openProjectChat(projectId: string): Promise<{ workspaceId: string; workspacePath: string }>
  /**
   * Create one project (POST `/agenthub/api/projects`, platform_admin).
   * The creator becomes the project's first owner; new projects start with an
   * empty Tool Set (fail-closed).
   */
  createProject(input: { name: string }): Promise<ProjectOption>
  listProjectSettings(): Promise<readonly ProjectSettingsRecord[]>
  /**
   * Re-read ONE project's settings (GET `/projects` + that project's memory).
   * Exists so a memory mutation refreshes only the project it changed instead of
   * every project's memory (N×2 requests).
   */
  listProjectSettingsFor(projectId: string): Promise<ProjectSettingsRecord>
  listApprovals(): Promise<readonly ApprovalRecord[]>
  listBadcases(): Promise<readonly BadcaseRecord[]>
  /**
   * Mark one audit record as a badcase (POST `/audit/:auditId/badcase`).
   *
   * Repeat calls for the same audit record update the existing verdict instead of
   * adding a second row, so the caller does not have to check first.
   */
  markBadcase(input: {
    auditId: string
    projectId: string
    cause: BadcaseCause
    note?: string
  }): Promise<BadcaseRecord>
  /** Close one badcase (POST `/badcases/:id/resolve`); the server resolves its project. */
  resolveBadcase(id: string): Promise<void>
  /**
   * 当前员工所属项目里、挂了系统连接的工具名。
   * 对话据此给这些工具挂登录卡片。
   */
  listBusinessTools(): Promise<readonly string[]>
  /**
   * 当前会话所在项目里，这个工具所属连接的登录状态。
   * 响应不含任何凭证。
   */
  getLoginState(tool: string, cwd: string): Promise<LoginState>
  /** 为当前员工签发侧边浏览器登录入口。 */
  startConnectionLogin(connectionId: string): Promise<{ url: string }>
  listConnectionHealth(): Promise<readonly ConnectionHealthRecord[]>
  listTasks(): Promise<readonly TaskRecord[]>
  listUsers(): Promise<readonly UserRecord[]>
  listRoles(): Promise<readonly RoleRecord[]>
  getAnalytics(): Promise<AnalyticsRecord>
  /** Approve/reject one pending request (POST /agenthub/api/approvals/:id/decide). */
  decideApproval(id: string, decision: 'approve' | 'reject', reason?: string): Promise<ApprovalRecord>
  /** Enable or disable one registry tool (POST /agenthub/api/tools/:id/enabled). */
  setToolEnabled(id: string, enabled: boolean): Promise<void>
  /**
   * Enable every not-yet-enabled tool assigned to one project
   * (POST /agenthub/api/tools/enable-all). Tools of other projects stay unchanged.
   */
  enableAllTools(projectId: string): Promise<{ readonly updated: number }>
  /** Remove one tool that belongs to the project (DELETE `/projects/:projectId/tools/:toolId`). */
  deleteTool(projectId: string, toolId: string): Promise<void>
  /** Remove one system connection and the tools scanned from it (DELETE `/connections/:id`). */
  deleteConnection(id: string): Promise<void>
  /** Remove one project, its connection, and the tools that belong only to it (DELETE `/projects/:id`). */
  deleteProject(id: string): Promise<void>
  /** Register one external system connection (POST /agenthub/api/connections). */
  createConnection(input: {
    projectId: string
    name: string
    baseUrl: string
    frontendUrl: string
    openapiUrl?: string
  }): Promise<CreatedConnection>
  /** Replace one connection's outbound allowlist (PUT /agenthub/api/connections/:id/allowlist). */
  setConnectionAllowlist(id: string, allowedHosts: readonly string[]): Promise<void>
  /**
   * Trigger an OpenAPI scan (POST /agenthub/api/connections/:id/scan).
   * @returns 同步 200 时有 receipt；202 后台扫描时 `undefined`（进度见弹窗 / `getScanProgress`）。
   */
  scanConnection(id: string): Promise<ScanReceipt | undefined>
  /**
   * Read one connection's scan progress (GET `/connections/:id/scan/progress`).
   *
   * 轮询而非流式：`RouteResult` 只能表达整段响应，加 SSE 要动路由核心；
   * 状态本身在服务端，所以关掉弹窗、刷新页面后仍能读到当前阶段与上次结果。
   * @param id - 连接 id。
   * @returns 进度；从未扫描过时为 `null`。
   */
  getScanProgress(id: string): Promise<ScanProgressRecord | null>
  /** Store one project credential; the plaintext never comes back (POST /agenthub/api/projects/:id/credentials). */
  bindCredential(input: {
    projectId: string
    systemConnectionId: string
    plaintext: string
    externalUserId?: string
    expiresAt?: string
  }): Promise<{ id: string; keyVersion: number; expiresAt: string | null }>
  /**
   * List one project's memories (GET `/projects/:id/memories`).
   * `scope` omitted → confirmed memories; `'candidate'` → awaiting-confirmation entries.
   */
  /** List one project's memories (GET `/projects/:id/memories`).
   * `scope` omitted → confirmed memories; `'candidate'` → awaiting-confirmation entries.
   */
  listMemories(projectId: string, scope?: 'candidate' | 'active'): Promise<readonly ProjectMemoryRecord[]>
  /**
   * Query one project's audit records (GET `/audit`).
   * Every filter is server-side; the project is mandatory (BND-4).
   */
  listAudit(query: AuditQuery): Promise<AuditPage>
  /** Confirm one candidate → it enters the injection set (POST `/:mid/confirm`). */
  confirmMemory(projectId: string, memoryId: string): Promise<ProjectMemoryRecord>
  /** Reject one candidate → hard delete (POST `/:mid/reject`). */
  rejectMemory(projectId: string, memoryId: string): Promise<void>
  /** Lock (always injected) or unlock one memory (POST `/:mid/lock` | `/:mid/unlock`). */
  setMemoryLocked(projectId: string, memoryId: string, locked: boolean): Promise<ProjectMemoryRecord>
  /** Delete one memory (DELETE `/:mid`); `hard=true` removes the row, otherwise soft delete. */
  deleteMemory(projectId: string, memoryId: string, hard?: boolean): Promise<void>
}

/** JSON API base path (U1: every console endpoint lives under this prefix). */
const API_BASE = '/agenthub/api'

/** CSRF double-submit cookie name (auth/cookies.ts; non-HttpOnly, JS-readable). */
const CSRF_COOKIE = 'agenthub_csrf'

/** Minimal `document.cookie` face: the host aggregate compiles this package without the DOM lib. */
interface CookieCarrier { readonly document?: { readonly cookie: string } }

/** Read one cookie value from `document.cookie` ('' when absent). */
function readCookie(name: string): string {
  const carrier: CookieCarrier = globalThis
  const jar = carrier.document?.cookie ?? ''
  for (const part of jar.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

/** The ambient fetch response, resolved so both lib.dom and @types/node type it. */
type FetchResponse = Awaited<ReturnType<typeof fetch>>

/** Read a non-2xx body's U5 `{message}`; falls back to a language-neutral status line. */
async function readError(path: string, res: FetchResponse): Promise<Error> {
  let message = `HTTP ${res.status} ${path}`
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const value = (body as { readonly message?: unknown }).message
      if (typeof value === 'string' && value !== '') message = value
    }
  } catch {
    // Non-JSON error bodies keep the status line above.
  }
  return new Error(message)
}

/** GET `/agenthub/api<path>` and decode JSON (throws the U5 message on non-2xx). */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw await readError(path, res)
  return await res.json() as T
}

/** POST `/agenthub/api<path>` as form-urlencoded with the CSRF header (U5 message on non-2xx). */
async function postForm<T>(path: string, body: Record<string, string>): Promise<T> {
  return await sendForm<T>('POST', path, body)
}

/**
 * 启动连接扫描：有进度注册表时 202 + 进度体；否则 200 + {@link ScanReceipt}。
 * 202 的 JSON 含 `phase`，不能当成 receipt（否则 UI 读 `created.length` 会崩）。
 */
async function postScanConnection(id: string): Promise<ScanReceipt | undefined> {
  const path = `/connections/${encodeURIComponent(id)}/scan`
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-csrf-token': readCookie(CSRF_COOKIE),
    },
    body: new URLSearchParams({}).toString(),
  })
  if (!res.ok) throw await readError(path, res)
  if (res.status === 202) {
    await res.json()
    return undefined
  }
  return await res.json() as ScanReceipt
}

/**
 * Send one form-urlencoded write with the CSRF header.
 *
 * `postForm` covers the common case; `PUT`-keyed replacements (the connection
 * allowlist) need the same headers and body encoding, so both go through here.
 * @param method - HTTP verb the route expects.
 * @param path - path below the API base.
 * @param body - form fields.
 * @returns the parsed JSON response.
 */
async function sendForm<T>(method: 'POST' | 'PUT', path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-csrf-token': readCookie(CSRF_COOKIE),
    },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) throw await readError(path, res)
  return await res.json() as T
}

/** DELETE `/agenthub/api<path>` with the CSRF header (U5 message on non-2xx). */
async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { accept: 'application/json', 'x-csrf-token': readCookie(CSRF_COOKIE) },
  })
  if (!res.ok) throw await readError(path, res)
  return await res.json() as T
}

/** Every list endpoint answers `{ items }`; unwrap to the seam's array shape. */
interface Items<T> { readonly items: readonly T[] }

/**
 * 连接列表 API 在旧服务端进程上可能缺 `frontendUrl` / `pendingHosts`；
 * 缺字段时整页会在 `pendingHosts.length` 处崩溃（slot 错误边界 → 空白主区）。
 */
function normalizeConnectionHealth(row: ConnectionHealthRecord): ConnectionHealthRecord {
  return {
    ...row,
    frontendUrl: row.frontendUrl !== undefined && row.frontendUrl !== '' ? row.frontendUrl : row.baseUrl,
    projectId: row.projectId ?? null,
    pendingHosts: row.pendingHosts ?? [],
    allowedHosts: row.allowedHosts ?? [],
  }
}

/** Normalize a thrown value into a display string (U5 errors are `Error` instances). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Memory collection path for one project (project id is opaque to other callers). */
function memoryPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/memories`
}

/**
 * Read one project's memory, split into the two sections the settings view renders.
 * @param projectId - project whose memory to read.
 * @returns confirmed memories and extraction candidates.
 */
async function readMemories(projectId: string): Promise<{
  memories: readonly ProjectMemoryRecord[]
  memoryCandidates: readonly ProjectMemoryRecord[]
}> {
  const [memories, memoryCandidates] = await Promise.all([
    httpApi.listMemories(projectId, 'active'),
    httpApi.listMemories(projectId, 'candidate'),
  ])
  return { memories, memoryCandidates }
}

/**
 * The real seam: 7 `list*` reads plus `getAnalytics` `fetch('/agenthub/api/*')`
 * with the session cookie; writes POST form-urlencoded bodies carrying the
 * `x-csrf-token` header read from `document.cookie`. `listProjectSettings` /
 * `listTasks` intentionally delegate to `mockApi`: P3 has no backend owner for
 * them (Agent/Memory/Files land in P4; tasks has no contract yet), so no
 * endpoints are invented for them.
 */
export const httpApi: AgenthubApi = {
  listTools: () => getJson<Items<ToolRecord>>('/tools').then(r => r.items),
  listProjectOptions: () => getJson<Items<ProjectOption>>('/projects').then(r => r.items),
  openProjectChat: projectId => postForm<{ workspaceId: string; workspacePath: string }>(
    `/projects/${encodeURIComponent(projectId)}/chat`,
    {},
  ),
  createProject: input => postForm<ProjectOption>('/projects', { name: input.name }),
  listApprovals: () => getJson<Items<ApprovalRecord>>('/approvals').then(r => r.items),
  listBadcases: () => getJson<Items<BadcaseRecord>>('/badcases').then(r => r.items),
  listBusinessTools: () => getJson<Items<string>>('/business-tools').then(r => r.items),
  getLoginState: (tool, cwd) => {
    const params = new URLSearchParams({ tool, cwd })
    return getJson<LoginState>(`/login-state?${params.toString()}`)
  },
  startConnectionLogin: connectionId =>
    postForm<{ url: string }>(`/connections/${encodeURIComponent(connectionId)}/login`, {}),
  listConnectionHealth: () =>
    getJson<Items<ConnectionHealthRecord>>('/connections').then(r => r.items.map(normalizeConnectionHealth)),
  listUsers: () => getJson<Items<UserRecord>>('/admin/users').then(r => r.items),
  listRoles: () => getJson<Items<RoleRecord>>('/admin/roles').then(r => r.items),
  getAnalytics: () => getJson<AnalyticsRecord>('/analytics'),
  resolveBadcase: id =>
    postForm<{ readonly id: string }>(`/badcases/${encodeURIComponent(id)}/resolve`, {})
      .then(() => undefined),
  markBadcase: input =>
    postForm<BadcaseRecord>(`/audit/${encodeURIComponent(input.auditId)}/badcase`, {
      projectId: input.projectId,
      category: input.cause,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
    }),
  decideApproval: (id, decision, reason) => {
    const body: Record<string, string> = { decision }
    if (reason !== undefined) body.reason = reason
    return postForm<ApprovalRecord>(`/approvals/${encodeURIComponent(id)}/decide`, body)
  },
  setToolEnabled: async (id, enabled) => {
    await postForm<{ readonly ok: boolean }>(`/tools/${encodeURIComponent(id)}/enabled`, { enabled: String(enabled) })
  },
  enableAllTools: projectId =>
    postForm<{ readonly ok: boolean; readonly updated: number }>('/tools/enable-all', { projectId })
      .then(body => ({ updated: body.updated })),
  deleteTool: async (projectId, toolId) => {
    await deleteJson<{ readonly id: string }>(
      `/projects/${encodeURIComponent(projectId)}/tools/${encodeURIComponent(toolId)}`,
    )
  },
  deleteConnection: async (id) => {
    await deleteJson<{ readonly id: string }>(`/connections/${encodeURIComponent(id)}`)
  },
  deleteProject: async (id) => {
    await deleteJson<{ readonly id: string }>(`/projects/${encodeURIComponent(id)}`)
  },
  createConnection: (input) => {
    const body: Record<string, string> = {
      projectId: input.projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      frontendUrl: input.frontendUrl,
    }
    if (input.openapiUrl !== undefined) body.openapiUrl = input.openapiUrl
    return postForm<CreatedConnection>('/connections', body)
  },
  setConnectionAllowlist: async (id, allowedHosts) => {
    await sendForm<{ readonly id: string }>(
      'PUT',
      `/connections/${encodeURIComponent(id)}/allowlist`,
      { allowedHosts: allowedHosts.join('\n') },
    )
  },
  scanConnection: id => postScanConnection(id),
  getScanProgress: id => getJson<ScanProgressRecord | null>(`/connections/${encodeURIComponent(id)}/scan/progress`),
  bindCredential: (input) => {
    const body: Record<string, string> = { systemConnectionId: input.systemConnectionId, plaintext: input.plaintext }
    if (input.externalUserId !== undefined) body.externalUserId = input.externalUserId
    if (input.expiresAt !== undefined) body.expiresAt = input.expiresAt
    return postForm<{ id: string; keyVersion: number; expiresAt: string | null }>(
      `/projects/${encodeURIComponent(input.projectId)}/credentials`, body,
    )
  },
  listMemories: (projectId, scope) => getJson<Items<ProjectMemoryRecord>>(
    `${memoryPath(projectId)}${scope === undefined ? '' : `?status=${scope}`}`,
  ).then(r => r.items),
  listAudit: (query) => {
    const params = new URLSearchParams({ projectId: query.projectId })
    if (query.userId !== undefined) params.set('userId', query.userId)
    if (query.toolId !== undefined) params.set('toolId', query.toolId)
    if (query.status !== undefined) params.set('status', query.status)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.offset !== undefined) params.set('offset', String(query.offset))
    return getJson<AuditPage>(`/audit?${params.toString()}`)
  },
  confirmMemory: (projectId, memoryId) =>
    postForm<ProjectMemoryRecord>(`${memoryPath(projectId)}/${encodeURIComponent(memoryId)}/confirm`, {}),
  rejectMemory: async (projectId, memoryId) => {
    await postForm<{ readonly rejected: boolean }>(
      `${memoryPath(projectId)}/${encodeURIComponent(memoryId)}/reject`, {},
    )
  },
  setMemoryLocked: (projectId, memoryId, locked) => postForm<ProjectMemoryRecord>(
    `${memoryPath(projectId)}/${encodeURIComponent(memoryId)}/${locked ? 'lock' : 'unlock'}`, {},
  ),
  deleteMemory: async (projectId, memoryId, hard) => {
    const suffix = hard === true ? '?hard=true' : ''
    await deleteJson<{ readonly id: string }>(`${memoryPath(projectId)}/${encodeURIComponent(memoryId)}${suffix}`)
  },
  /**
   * Project settings. Memory is backend-owned (阶段 C): one list + one candidate
   * query per project. The remaining tabs (Agent / Tool Set / Files / Members)
   * keep the prototype fixtures until a backend owner lands — see
   * {@link AGENT_TAB_PLACEHOLDER}.
   */
  listProjectSettings: async () => {
    const options = await httpApi.listProjectOptions()
    const fixtures = await mockApi.listProjectSettings()
    return await Promise.all(options.map(async option => ({
      ...settingsBase(option, fixtures),
      ...await readMemories(option.id),
    })))
  },
  listProjectSettingsFor: async (projectId) => {
    const options = await httpApi.listProjectOptions()
    const option = options.find(item => item.id === projectId)
    if (option === undefined) throw new Error(`project not found: ${projectId}`)
    const fixtures = await mockApi.listProjectSettings()
    // Only this project is re-read: a memory mutation must not refetch every project.
    return { ...settingsBase(option, fixtures), ...await readMemories(projectId) }
  },
  // Deliberate gap: tasks has no backend owner yet — keep the prototype fixtures.
  listTasks: () => mockApi.listTasks(),
}

/**
 * The non-memory half of one settings record: real project identity plus the
 * prototype fixtures for tabs that have no backend owner yet.
 * @param option - the project's id and name from the real project list.
 * @param fixtures - prototype settings records, matched by project name.
 * @returns the settings record without its memory sections.
 */
function settingsBase(
  option: ProjectOption,
  fixtures: readonly ProjectSettingsRecord[],
): Omit<ProjectSettingsRecord, 'memories' | 'memoryCandidates'> {
  const fixture = fixtures.find(item => item.name === option.name)
  return {
    id: option.id,
    name: option.name,
    system: fixture?.system ?? '',
    agent: fixture?.agent ?? AGENT_TAB_PLACEHOLDER,
    toolSet: fixture?.toolSet ?? [],
    toolOptions: fixture?.toolOptions ?? [],
    files: fixture?.files ?? [],
    members: fixture?.members ?? [],
  }
}
