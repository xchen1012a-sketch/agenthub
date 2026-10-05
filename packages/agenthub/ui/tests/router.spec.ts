import { describe, expect, it } from 'vitest'
import { AgenthubError, asUserId, type Queryable } from '@agenthub/_shared'
import { AuthService, type AuthIdentity, type AuthUser } from '@agenthub/auth'
import { RbacService } from '@agenthub/rbac'
import type { BadcaseCause } from '@agenthub/audit'
import { escapeHtml, loginPage, projectsPage, sessionsPage } from '../src/index.ts'
import {
  handleAgenthubRequest,
  type AnalyticsRecord,
  type BadcaseRecord,
  type ConnectionHealthRecord,
  type ProjectOption,
  type RoleRecord,
  type RouterDeps,
  type ToolRecord,
  type UserRecord,
} from '../src/index.ts'

const USER_ID = asUserId('00000000-0000-4000-8000-000000000001')

const TOOL_ID = '11111111-1111-4111-8111-111111111111'
const TOOL2_ID = '11111111-1111-4111-8111-222222222222'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const CREDENTIAL_ID = '44444444-4444-4444-8444-444444444444'
const PROJECT_ID = '55555555-5555-4555-8555-555555555555'

const DEV_IDENTITY: AuthIdentity = {
  userId: USER_ID,
  displayName: 'Dev Admin',
  roles: ['platform_admin'],
  sessionId: null,
}

/**
 * 非空运营指标快照（对应下面 analytics 用例的期望值）。
 *
 * `previous` 的取值是按旧内联实现的行为反推的：旧实现对越界或空值回落 `0`（`?? 0`），
 * 因此"无前窗口"表现为 `prevTotal = 0` → toolCalls 环比 null；而成功率按百分点差计算。
 */
const HAPPY_SNAPSHOT = {
  toolCalls: 100,
  successRate: 90,
  activeUsers: 8,
  sessions: 20,
  approvals: 12,
  previous: { toolCalls: 100, successRate: 77, badcaseTotal: 1, activeUsers: 10, sessions: 10 },
  previousApprovals: 6,
  badcaseTotal: 3,
  badcaseDistribution: [{ cause: 'bad_param', count: 2 }, { cause: 'timeout', count: 1 }],
  toolTrend: [...new Array<number>(13).fill(0), 5].map((value, index) => (index === 11 ? 3 : value)),
  topTools: [{ api: 'noop_write', count: 7 }],
}

/** 空集运营指标快照（全零 + 无前窗口）。 */
const EMPTY_SNAPSHOT = {
  toolCalls: 0,
  successRate: 0,
  activeUsers: 0,
  sessions: 0,
  approvals: 0,
  previous: { toolCalls: 0, successRate: 0, badcaseTotal: 0, activeUsers: 0, sessions: 0 },
  previousApprovals: 0,
  badcaseTotal: 0,
  badcaseDistribution: [],
  toolTrend: new Array<number>(14).fill(0),
  topTools: [],
}

/** 审计与坏例用例共用的项目 / 审计记录 / 坏例 id。 */
const AUDIT_PROJECT = '88888888-8888-4888-8888-888888888888'
const AUDIT_ID = '99999999-9999-4999-8999-999999999999'
const BADCASE_ID = '77777777-7777-4777-8777-777777777777'

/** 领域服务的进程内假实现（同一数据面，覆盖路由全流程；含阶段 D 的 db/connector/vault/ingest）。 */
function fakeDeps(options: { emptyAnalytics?: boolean; member?: boolean } = {}) {
  const empty = options.emptyAnalytics === true
  const isMember = options.member !== false
  const projects: { id: string; name: string; createdBy: string; connectionId?: string | null }[] = []
  const chatIntents: { projectId: string; userId: string }[] = []
  const connectionIds = new Set<string>([CONNECTION_ID])
  const approvals = new Map<string, { status: string; reason: string | null }>()
  const snapshots = [
    {
      header: { id: 's-1', createdAt: 1_760_000_000_000 },
      eventCount: 7,
    },
  ]
  // 阶段 D 读面数据。
  const toolRows = [
    {
      id: TOOL_ID,
      name: 'query_customer',
      description: '查询客户',
      parameters: { type: 'object' },
      source: 'openapi',
      source_ref: 'GET /customer/list',
      risk_level: 'read',
      requires_approval: false,
      enabled: true,
      connection_name: 'CRM Production',
      project_ids: ['p-1'],
      connection_id: null as string | null,
    },
    {
      id: TOOL2_ID,
      name: 'delete_order',
      description: '删除订单',
      parameters: { type: 'object' },
      source: 'manual',
      source_ref: null as string | null,
      risk_level: 'critical',
      requires_approval: true,
      enabled: false,
      connection_name: null as string | null,
      project_ids: [] as string[],
      connection_id: null as string | null,
    },
  ]
  const storedCredentials: { plaintext: string }[] = []
  // 结构化 SQL 假 DB（按语句特征返回；空集模式返回零值/空行）。
  const db = {
    async query(text: string, values?: readonly unknown[]) {
      // 记忆路由的成员守卫（RbacService.requireProjectMember）读 project_members：
      // 同一数据面里 DEV_IDENTITY 恒为该 Project 的 admin（跨 Project 越权由
      // 「他 Project 的 admin 审批」用例覆盖）。
      if (text.includes('FROM project_members pm')) return { rows: isMember ? [{ role: 'admin' }] : [] }
      if (text.includes('FROM tools t LEFT JOIN system_connections')) return { rows: toolRows }
      if (text.includes('UPDATE tools AS t SET enabled = true') && text.includes('project_tool_set pts')) {
        const projectId = typeof values?.[0] === 'string' ? values[0] : ''
        const updated = toolRows.filter(row => row.enabled === false && row.project_ids.includes(projectId))
        for (const row of updated) row.enabled = true
        return { rows: updated.map(row => ({ id: row.id })) }
      }
      if (text.includes('DELETE FROM tools AS t WHERE t.id = $1') && text.includes('pts.project_id = $2')) {
        const toolId = String(values?.[0] ?? '')
        const projectId = String(values?.[1] ?? '')
        const index = toolRows.findIndex(row => row.id === toolId && row.project_ids.includes(projectId))
        if (index < 0) return { rows: [] }
        toolRows.splice(index, 1)
        return { rows: [{ id: toolId }] }
      }
      if (text.includes('t.system_connection_id = (SELECT p.system_connection_id FROM projects p WHERE p.id = $1)')) {
        const projectId = String(values?.[0] ?? '')
        const connectionId = projects.find(item => item.id === projectId)?.connectionId ?? null
        if (connectionId === null) return { rows: [] }
        const removed = toolRows.filter(row => row.connection_id === connectionId)
        for (let index = toolRows.length - 1; index >= 0; index -= 1) {
          if (toolRows[index]?.connection_id === connectionId) toolRows.splice(index, 1)
        }
        return { rows: removed.map(row => ({ id: row.id })) }
      }
      if (text.includes('project_tool_set other')) {
        const projectId = String(values?.[0] ?? '')
        const removed = toolRows.filter(row =>
          row.project_ids.includes(projectId) && row.project_ids.every(id => id === projectId))
        for (let index = toolRows.length - 1; index >= 0; index -= 1) {
          const row = toolRows[index]
          if (row !== undefined && row.project_ids.includes(projectId) && row.project_ids.every(id => id === projectId)) {
            toolRows.splice(index, 1)
          }
        }
        return { rows: removed.map(row => ({ id: row.id })) }
      }
      if (text.includes('DELETE FROM system_connections AS sc')) {
        const projectId = String(values?.[0] ?? '')
        const connectionId = projects.find(item => item.id === projectId)?.connectionId ?? null
        if (connectionId === null || !connectionIds.has(connectionId)) return { rows: [] }
        connectionIds.delete(connectionId)
        return { rows: [{ id: connectionId }] }
      }
      if (text.includes('DELETE FROM tools WHERE system_connection_id = $1')) {
        const connectionId = String(values?.[0] ?? '')
        const removed = toolRows.filter(row => row.connection_id === connectionId)
        for (let index = toolRows.length - 1; index >= 0; index -= 1) {
          if (toolRows[index]?.connection_id === connectionId) toolRows.splice(index, 1)
        }
        return { rows: removed.map(row => ({ id: row.id })) }
      }
      if (text.includes('DELETE FROM system_connections WHERE id = $1')) {
        const id = String(values?.[0] ?? '')
        if (!connectionIds.has(id)) return { rows: [] }
        connectionIds.delete(id)
        return { rows: [{ id }] }
      }
      if (text.includes('DELETE FROM projects WHERE id = $1')) {
        const projectId = String(values?.[0] ?? '')
        const index = projects.findIndex(item => item.id === projectId)
        if (index < 0) return { rows: [] }
        projects.splice(index, 1)
        return { rows: [{ id: projectId }] }
      }
      if (text.includes('UPDATE tools SET enabled')) {
        const id = values?.[0]
        const target = toolRows.find(row => row.id === (typeof id === 'string' ? id : ''))
        if (target === undefined) return { rows: [] }
        target.enabled = Boolean(values?.[1])
        return { rows: [{ id: target.id }] }
      }
      if (text.includes('AS tool_count')) {
        return { rows: [{ system_connection_id: CONNECTION_ID, tool_count: 3 }] }
      }
      if (text.includes('AS cur_total')) {
        return {
          rows: [
            empty
              ? { cur_total: 0, cur_ok: 0, prev_total: 0, prev_ok: 0 }
              : { cur_total: 100, cur_ok: 90, prev_total: 100, prev_ok: 80 },
          ],
        }
      }
      if (text.includes('AS cur_sessions')) {
        return {
          rows: [
            empty
              ? { cur_sessions: 0, prev_sessions: 0, cur_dau: 0, prev_dau: 0 }
              : { cur_sessions: 20, prev_sessions: 10, cur_dau: 8, prev_dau: 10 },
          ],
        }
      }
      if (text.includes('FROM badcases WHERE created_at') && text.includes('AS cur_count')) {
        return {
          rows: [empty ? { cur_count: 0, prev_count: 0 } : { cur_count: 3, prev_count: 2 }],
        }
      }
      if (text.includes('FROM approvals WHERE created_at')) {
        return {
          rows: [empty ? { cur_count: 0, prev_count: 0 } : { cur_count: 12, prev_count: 6 }],
        }
      }
      if (text.includes('AS days_ago')) {
        return { rows: empty ? [] : [{ days_ago: 0, call_count: 5 }, { days_ago: 2, call_count: 3 }] }
      }
      if (text.includes('AS cause_count')) {
        return {
          rows: empty ? [] : [{ category: 'bad_param', cause_count: 2 }, { category: 'timeout', cause_count: 1 }],
        }
      }
      if (text.includes('AS call_total')) {
        return { rows: empty ? [] : [{ tool_name: 'noop_write', call_total: 7 }] }
      }
      if (text.includes('FROM badcases b')) {
        return {
          rows: [
            {
              id: 'b-1',
              created_at: '2026-09-27T10:00:00.000Z',
              category: 'bad_param',
              category_note: '参数错',
              ai_summary: '摘要',
              resolved: false,
              project_name: '销售',
              user_name: '张三',
              session_id: 's-1',
              tool_name: 'query_customer',
            },
            {
              id: 'b-2',
              created_at: '2026-09-26T10:00:00.000Z',
              category: 'timeout',
              category_note: null,
              ai_summary: null,
              resolved: true,
              project_name: null,
              user_name: null,
              session_id: null,
              tool_name: null,
            },
          ],
        }
      }
      if (text.includes('AS role_names')) {
        return {
          rows: [
            { id: 'u-1', display_name: '张三', email: 'z@x', status: 'active', role_names: 'member、platform_admin' },
            { id: 'u-2', display_name: '李四', email: 'l@x', status: 'disabled', role_names: '' },
          ],
        }
      }
      if (text.includes('AS member_count')) {
        return { rows: [{ name: 'member', member_count: 5 }, { name: 'platform_admin', member_count: 2 }] }
      }
      if (text.includes('FROM project_members pm')) return { rows: isMember ? [{ role: 'admin' }] : [] }
      if (text.includes('SELECT DISTINCT t.name FROM tools t') && text.includes('JOIN system_connections')) {
        return { rows: [{ name: 'writeAnything' }] }
      }
      if (text.includes('SELECT c.id, c.name FROM tools t') && text.includes('WHERE t.name = $1 AND p.id = $2')) {
        const tool = String(values?.[0] ?? '')
        const projectId = String(values?.[1] ?? '')
        if (tool === 'writeAnything' && projectId === PROJECT_ID) {
          return { rows: [{ id: CONNECTION_ID, name: 'CRM Production' }] }
        }
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
  let reloadCount = 0
  const connector = {
    async reloadTools() {
      reloadCount += 1
    },
    async listConnections() {
      return [
        {
          id: CONNECTION_ID,
          name: 'CRM Production',
          baseUrl: 'https://crm.example.com',
          frontendUrl: 'https://crm.example.com',
          projectId: 'p-1',
          pendingHosts: [],
          authMode: 'oauth2',
          openapiUrl: 'https://crm.example.com/openapi.json',
          hasOpenapiDoc: false,
          createdBy: USER_ID,
          createdAt: '2026-09-27T00:00:00.000Z',
          updatedAt: '2026-09-27T00:00:00.000Z',
        },
      ]
    },
    loginHost() {
      return 'login.test:5080'
    },
    async startLogin(userId: string, _roles: readonly string[], connectionId: string) {
      if (!isMember) {
        throw new AgenthubError('agenthub/system-connector/ProxyForbidden', '你不是该连接所属 Project 的成员，拒绝反代', { httpStatus: 403 })
      }
      return `http://login.test:5080/agenthub/connections/${connectionId}/enter?ticket=${userId.slice(0, 8)}`
    },
    async createConnection(input: {
      userId: string
      projectId: string
      name: string
      baseUrl: string
      frontendUrl: string
      openapiUrl?: string | null
    }) {
      return {
        id: '66666666-6666-4666-8666-666666666666',
        name: input.name,
        baseUrl: input.baseUrl,
        frontendUrl: input.frontendUrl,
        projectId: input.projectId,
        pendingHosts: [],
        authMode: 'session',
        openapiUrl: input.openapiUrl ?? null,
        hasOpenapiDoc: false,
        createdBy: input.userId,
        createdAt: '2026-09-27T00:00:00.000Z',
        updatedAt: '2026-09-27T00:00:00.000Z',
      }
    },
  }
  const vault = {
    async credentialStatus() {
      return 'missing' as const
    },
    async storeCredential(input: {
      userId: string
      systemConnectionId: string
      plaintext: string
      externalUserId?: string | null
      expiresAt?: Date | string | null
    }) {
      storedCredentials.push({ plaintext: input.plaintext })
      const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : String(input.expiresAt)
      return { id: CREDENTIAL_ID, keyVersion: 1, expiresAt }
    },
  }
  const ingest = {
    async ingestFromUrl() {
      return {
        created: ['query_customer'],
        skipped: [{ name: 'delete_order', sourceRef: 'DELETE /order/{id}', reason: 'duplicate_operation_id' }],
        total: 2,
      }
    },
  }
  /** 记忆假服务：内存行 + 与 ProjectMemoryService 同构的归属语义（D33 / BND-4）。 */
  interface FakeMemory {
    id: string
    projectId: string
    content: string
    locked: boolean
    status: 'candidate' | 'active'
    deleted: boolean
    createdAt: string
    updatedAt: string
  }
  const memories: FakeMemory[] = []
  const allMemories = (projectId: string): FakeMemory[] =>
    memories.filter(item => item.projectId === projectId && !item.deleted)
  const memory = {
    async listMemories(projectId: string, options?: { scope?: 'candidate' | 'active'; includeDeleted?: boolean }) {
      const base = options?.includeDeleted === true
        ? memories.filter(item => item.projectId === projectId)
        : allMemories(projectId)
      if (options?.scope === undefined) return base.filter(item => item.status === 'active')
      return base.filter(item => item.status === options.scope)
    },
    async listCandidates(projectId: string) {
      return allMemories(projectId).filter(item => item.status === 'candidate')
    },
    async confirmCandidate(id: string, projectId: string) {
      // 归属校验与写操作同一条语句内判定（D33）：跨 Project 命中 0 行即 null。
      const row = memories.find(item => item.id === id && item.projectId === projectId && item.status === 'candidate')
      if (row === undefined) return null
      row.status = 'active'
      return row
    },
    async rejectCandidate(id: string, projectId: string) {
      const index = memories.findIndex(item => item.id === id && item.projectId === projectId && item.status === 'candidate')
      if (index < 0) return false
      memories.splice(index, 1)
      return true
    },
    async setLocked(id: string, locked: boolean, projectId: string) {
      const row = memories.find(item => item.id === id && item.projectId === projectId)
      if (row === undefined) return null
      row.locked = locked
      return row
    },
    async softDelete(id: string, projectId: string) {
      const row = memories.find(item => item.id === id && item.projectId === projectId)
      if (row === undefined) return false
      row.deleted = true
      return true
    },
    async hardDelete(id: string, projectId: string) {
      const index = memories.findIndex(item => item.id === id && item.projectId === projectId)
      if (index < 0) return false
      memories.splice(index, 1)
      return true
    },
  }
  let seq = 0
  /** 审计查询替身：回放固定分页形状（路由只做参数校验与转发）。 */
  const audit = {
    async listRecords(filter: { projectId: string; limit?: number; offset?: number }) {
      expect(filter.projectId).toBeTruthy()
      return {
        items: [{
          id: 'a-1',
          project_id: filter.projectId,
          user_id: null,
          session_id: null,
          tool_id: null,
          tool_name: 'delete_order',
          risk_level: 'critical',
          status: 'denied',
          trace_id: 'tid-1',
          created_at: new Date('2026-10-03T00:00:00.000Z'),
        }],
        total: 1,
      }
    },
    /** P5：坏例登记（幂等）— 回放固定行，路由只做校验与转发。 */
    async markBadcase(input: { auditId: string; projectId: string; category: BadcaseCause; note?: string | null }) {
      expect(input.projectId).toBeTruthy()
      return {
        id: 'bc-1',
        audit_id: input.auditId,
        category: input.category,
        category_note: input.note ?? null,
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        created_at: new Date('2026-10-03T00:00:00.000Z'),
      }
    },
    /** P5：查坏例归属项目 — 命中已知坏例时返回审计项目。 */
    async findBadcaseProject(badcaseId: string) {
      return badcaseId === BADCASE_ID ? AUDIT_PROJECT : null
    },
    /** P5：坏例销号 — 仅未销号行命中。 */
    async resolveBadcase(badcaseId: string, projectId: string) {
      expect(projectId).toBeTruthy()
      if (badcaseId !== BADCASE_ID) return null
      return {
        id: BADCASE_ID,
        audit_id: AUDIT_ID,
        category: 'wrong_tool' as const,
        category_note: null,
        resolved: true,
        resolved_by: null,
        resolved_at: new Date('2026-10-03T00:00:00.000Z'),
        created_at: new Date('2026-10-03T00:00:00.000Z'),
      }
    },
  }
  /**
   * 运营指标替身（P5：指标计算已迁至 @agenthub/analytics）。
   * 路由只做形状映射，故此处直接给出快照，断言映射结果。
   */
  const analyticsStub = (empty: boolean) => ({
    async aggregate() {
      return empty ? EMPTY_SNAPSHOT : HAPPY_SNAPSHOT
    },
  })
  const deps: RouterDeps = {
    auth: new AuthService({ db: { query: async () => ({ rows: [] }) } }),
    rbac: new RbacService({ db: db as unknown as Queryable }),
    audit,
    analytics: analyticsStub(empty),
    approval: {
      async decide(approvalId: string, _approverId: string, decision: 'approve' | 'reject', reason?: string) {
        const existing = approvals.get(approvalId)
        if (existing === undefined) {
          throw new AgenthubError('agenthub/approval/NotFound', '审批记录不存在', { httpStatus: 404 })
        }
        if (existing.status !== 'pending') {
          throw new AgenthubError('agenthub/approval/AlreadyDecided', '首次决策生效后不可再次决策', { httpStatus: 409 })
        }
        existing.status = decision === 'approve' ? 'approved' : 'rejected'
        existing.reason = reason ?? null
        return {
          id: approvalId,
          projectId: 'p-1',
          toolId: 't-1',
          toolName: 'noop_write',
          riskLevel: 'write',
          status: existing.status,
          approverId: _approverId,
          decidedAt: new Date(0).toISOString(),
          reason: existing.reason,
          createdAt: new Date(0).toISOString(),
          expiresAt: new Date(1).toISOString(),
        }
      },
      async listApprovals(viewerId: string, status?: string) {
        expect(viewerId).toBe(USER_ID)
        return [...approvals.entries()]
          .filter(([, item]) => status === undefined || item.status === status)
          .map(([id, item]) => ({
            id,
            projectId: 'p-1',
            toolId: 't-1',
            toolName: 'noop_write',
            riskLevel: 'write',
            status: item.status,
            approverId: null,
            decidedAt: null,
            reason: item.reason,
            createdAt: new Date(0).toISOString(),
            expiresAt: new Date(1).toISOString(),
          }))
      },
    },
    sessions: {
      list: async () => snapshots,
    } as unknown as RouterDeps['sessions'],
    project: {
      async listProjects(userId: string) {
        return projects
          .filter(project => project.createdBy === userId)
          .map(project => ({
            id: project.id,
            name: project.name,
            description: null,
            status: 'active' as const,
            harnessWorkspaceId: 'mem:x',
            createdBy: project.createdBy,
            createdAt: '2026-09-27T00:00:00.000Z',
          }))
      },
      async createProject(input: { userId: string; name: string }, _traceId: string | null) {
        seq += 1
        const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
        projects.push({ id, name: input.name, createdBy: input.userId })
        return {
          id,
          name: input.name,
          description: null,
          status: 'active' as const,
          harnessWorkspaceId: `mem:${id}`,
          createdBy: input.userId,
          createdAt: '2026-09-27T00:00:00.000Z',
        }
      },
      async resolveProjectContext(userId: string, projectId: string) {
        const project = projects.find(item => item.id === projectId)
        if (project === undefined) {
          throw new AgenthubError('agenthub/project/NotFound', 'Project 不存在', { httpStatus: 404 })
        }
        if (project.createdBy !== userId) {
          throw new AgenthubError('agenthub/project/NotMember', '你不是该 Project 的成员', { httpStatus: 403 })
        }
        return { projectId, workspaceId: `mem:${projectId}`, role: 'admin' as const, name: project.name }
      },
      async findByWorkspaceId(workspaceId: string) {
        const id = workspaceId.startsWith('mem:') ? workspaceId.slice(4) : workspaceId
        const project = projects.find(item => item.id === id)
        return project === undefined ? null : { id: project.id, name: project.name }
      },
      async prepareChatWorkspace(userId: string, projectId: string) {
        await (this as { resolveProjectContext(userId: string, projectId: string): Promise<unknown> })
          .resolveProjectContext(userId, projectId)
        return { workspaceId: `mem:${projectId}`, workspacePath: `/data/${projectId}` }
      },
    } as unknown as RouterDeps['project'],
    memory,
    db: db as unknown as Queryable,
    connector,
    vault,
    ingest,
    toolScope: {
      expectChat(projectId: string, userId: string) {
        chatIntents.push({ projectId, userId })
      },
    },
    workspaces: {
      async resolveByPath(path: string) {
        if (path === `/data/${PROJECT_ID}`) return { id: `mem:${PROJECT_ID}` }
        return undefined
      },
    },
  }
  return { deps, projects, approvals, toolRows, storedCredentials, memories, connectionIds, connectorReloads: () => reloadCount, chatIntents }
}

function get(path: string, acceptLanguage?: string) {
  return {
    method: 'GET',
    path,
    query: new URLSearchParams(),
    acceptLanguage,
    form: undefined,
    traceId: 'tid',
    user: DEV_IDENTITY,
    csrfToken: 'csrf-token',
    cookieHeader: undefined,
  }
}

function del(path: string) {
  return { ...post(path, new URLSearchParams()), method: 'DELETE' }
}

function post(path: string, form: URLSearchParams) {
  return {
    method: 'POST',
    path,
    query: new URLSearchParams(),
    acceptLanguage: 'zh-CN',
    form,
    traceId: 'tid',
    user: DEV_IDENTITY,
    csrfToken: 'csrf-token',
    cookieHeader: 'dsh_session=stub',
  }
}

/** GET + query 参数（path 与 query 分离，匹配路由精确比较）。 */
function apiGet(path: string, query: Record<string, string> = {}) {
  return { ...get(path), query: new URLSearchParams(query) }
}

describe('/agenthub 路由（U2 路径约定）', () => {
  it('GET /agenthub/login → 200 登录页（dev 一键 + CSRF 隐藏字段）', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/login'))
    expect(result.status).toBe(200)
    expect(result.html).toContain('登录 (dev)')
    expect(result.html).toContain('name="_csrf"')
  })

  it('POST /agenthub/logout → 302 回登录页 + 清除会话 Cookie', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, post('/agenthub/logout', new URLSearchParams()))
    expect(result.status).toBe(302)
    expect(result.location).toBe('/agenthub/login')
    expect(result.cookies?.[0]).toContain('=')
  })

  it('GET /agenthub/sessions → platform_admin 可见 Session 快照列表', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/sessions'))
    expect(result.status).toBe(200)
    expect(result.html).toContain('s-1')
    expect(result.html).toContain('7')
  })

  it('POST /agenthub/login → 302 跳列表页', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, post('/agenthub/login', new URLSearchParams()))
    expect(result).toEqual({ status: 302, location: '/agenthub/projects' })
  })

  it('GET /agenthub/projects → 列表页（空态 + New Project 表单）', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/projects', 'zh-CN'))
    expect(result.status).toBe(200)
    expect(result.html).toContain('项目列表')
    expect(result.html).toContain('还没有项目')
  })

  it('POST /agenthub/projects → 建项目 → 302 详情；列表页出现新项目', async () => {
    const { deps } = fakeDeps()
    const created = await handleAgenthubRequest(
      deps,
      post('/agenthub/projects', new URLSearchParams({ name: '平台组' })),
    )
    expect(created.status).toBe(302)
    expect(created.location).toMatch(/^\/agenthub\/projects\/[0-9a-f-]{36}$/)
    const listed = await handleAgenthubRequest(deps, get('/agenthub/projects'))
    expect(listed.html).toContain('平台组')
  })

  it('GET /agenthub/projects/<id> → 详情页（含 workspace 标签与 i18n 文案）', async () => {
    const { deps } = fakeDeps()
    const created = await handleAgenthubRequest(
      deps,
      post('/agenthub/projects', new URLSearchParams({ name: 'P' })),
    )
    const result = await handleAgenthubRequest(deps, get(created.location!))
    expect(result.status).toBe(200)
    expect(result.html).toContain('mem:')
    expect(result.html).toContain('project-tool-scope')
  })

  it('非成员访问他人详情 → 403 错误页（project_isolation 用户故事级）', async () => {
    const { deps, projects } = fakeDeps()
    projects.push({ id: '99999999-9999-4999-8999-999999999999', name: '他人', createdBy: 'other' })
    const result = await handleAgenthubRequest(
      deps,
      get('/agenthub/projects/99999999-9999-4999-8999-999999999999'),
    )
    expect(result.status).toBe(403)
    expect(result.html).toContain('不是该 Project 的成员')
  })

  it('非法项目 ID → 404；未知路径 → 404', async () => {
    const { deps } = fakeDeps()
    const bad = await handleAgenthubRequest(deps, get('/agenthub/projects/not-a-uuid'))
    expect(bad.status).toBe(404)
    const unknown = await handleAgenthubRequest(deps, get('/agenthub/whatever'))
    expect(unknown.status).toBe(404)
  })

  it('真登录模式下空表单登录 → 401 错误页（InvalidCredential 透出）', async () => {
    const deps: RouterDeps = {
      auth: new AuthService({
        db: { query: async () => ({ rows: [] }) },
        env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: 'unit-test-cookie-secret-0123456789abcdef' },
      }),
      rbac: new RbacService(),
      project: null as never,
      approval: null as never,
      sessions: { list: async () => [] } as unknown as RouterDeps['sessions'],
    }
    const result = await handleAgenthubRequest(
      deps,
      post('/agenthub/login', new URLSearchParams({ email: '', password: '' })),
    )
    expect(result.status).toBe(401)
    expect(result.html).toContain('邮箱或密码不正确')
  })
})

describe('/agenthub/api/approvals（P3 阶段 B 审批 JSON API）', () => {
  const APPROVAL_ID = '11111111-2222-4333-8444-555555555555'

  it('GET /agenthub/api/approvals → 200 JSON 列表（status 过滤）', async () => {
    const { deps, approvals } = fakeDeps()
    approvals.set(APPROVAL_ID, { status: 'pending', reason: null })
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/approvals'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: { id: string; status: string }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: APPROVAL_ID, status: 'pending' })
  })

  it('POST decide approve → 200 JSON 记录（表单体 decision/reason）', async () => {
    const { deps, approvals } = fakeDeps()
    approvals.set(APPROVAL_ID, { status: 'pending', reason: null })
    const result = await handleAgenthubRequest(
      deps,
      post(`/agenthub/api/approvals/${APPROVAL_ID}/decide`, new URLSearchParams({ decision: 'approve', reason: 'ok' })),
    )
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ id: APPROVAL_ID, status: 'approved', reason: 'ok' })
  })

  it('decision 非法 → 400；非 UUID → 404；已决 → 409（U5 JSON envelope）', async () => {
    const { deps, approvals } = fakeDeps()
    approvals.set(APPROVAL_ID, { status: 'approved', reason: null })
    const badDecision = await handleAgenthubRequest(
      deps,
      post(`/agenthub/api/approvals/${APPROVAL_ID}/decide`, new URLSearchParams({ decision: 'maybe' })),
    )
    expect(badDecision.status).toBe(400)
    const badId = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/approvals/not-a-uuid/decide', new URLSearchParams({ decision: 'approve' })),
    )
    expect(badId.status).toBe(404)
    const conflict = await handleAgenthubRequest(
      deps,
      post(`/agenthub/api/approvals/${APPROVAL_ID}/decide`, new URLSearchParams({ decision: 'reject' })),
    )
    expect(conflict.status).toBe(409)
    expect((conflict.json as { message?: string }).message).toContain('首次决策')
  })
})

describe('render 基础防护', () => {
  it('escapeHtml 转义注入向量', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)">')).not.toContain('<img')
  })

  it('列表页渲染不含未转义的项目名', () => {
    const html = projectsPage('zh', [{ id: 'x', name: '<script>' }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('页面 HTML 骨架', () => {
  it('登录页是完整 HTML（lang、viewport、charset、CSRF）', () => {
    const html = loginPage('zh', 'csrf-token', false)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('lang="zh"')
    expect(html).toContain('viewport')
    expect(html).toContain('charset="utf-8"')
    expect(html).toContain('value="csrf-token"')
  })

  it('会话列表页空态与转义', () => {
    expect(sessionsPage('zh', [])).toContain('还没有持久化会话')
    const html = sessionsPage('zh', [{ id: '<x>', createdAt: 0, eventCount: 1 }])
    expect(html).not.toContain('<x>')
    expect(html).toContain('&lt;x&gt;')
  })

  it('身份视角与类型面稳定（AuthUser → rbac 最小视图）', () => {
    const user: AuthUser = { userId: USER_ID, displayName: 'Dev Admin', roles: ['platform_admin'] }
    expect(user.roles).toEqual(['platform_admin'])
  })
})

describe('阶段 D JSON API（工具 / 连接 / 分析 / 坏例 / 管理 / 项目）', () => {
  it('GET /agenthub/api/tools → 200 映射（method/path/source/risk/status/usedBy/result）', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/tools'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: ToolRecord[] }).items
    expect(items).toHaveLength(2)
    expect(items.find(item => item.id === TOOL_ID)).toMatchObject({
      api: 'query_customer',
      method: 'GET',
      path: '/customer/list',
      source: 'CRM Production',
      risk: 'read',
      approval: false,
      status: 'enabled',
      usedBy: ['p-1'],
      desc: '查询客户',
      result: '',
    })
    expect(items.find(item => item.id === TOOL2_ID)).toMatchObject({
      method: '',
      path: '',
      source: 'manual',
      risk: 'critical',
      approval: true,
      status: 'disabled',
      usedBy: [],
    })
  })

  it('GET /agenthub/api/connections → 200 派生健康（type / tools 计数 / status / lastCheck）', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/connections'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: ConnectionHealthRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: CONNECTION_ID,
      name: 'CRM Production',
      baseUrl: 'https://crm.example.com',
      frontendUrl: 'https://crm.example.com',
      projectId: 'p-1',
      pendingHosts: [],
      type: 'openapi',
      auth: 'oauth2',
      status: 'healthy',
      tools: 3,
      lastCheck: '2026-09-27T00:00:00.000Z',
    })
  })

  it('GET /agenthub/api/analytics?window=14d → 200 KPI / 环比 / 趋势 / 归因 / 排行', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, apiGet('/agenthub/api/analytics', { window: '14d' }))
    expect(result.status).toBe(200)
    const record = result.json as AnalyticsRecord
    // 映射断言：服务快照 → AnalyticsRecord（KPI 直接取自快照 + 比率换算）。
    expect(record.kpi).toEqual({ dau: 8, sessions: 20, toolCalls: 100, successRate: 90, badcaseRate: 3, approvalRate: 12 })
    // 环比方向：dau/sessions 取前窗口值算相对百分数；比率的完整数学由
    // @agenthub/analytics 的测试覆盖，此处只锁"值确实传下来且方向正确"。
    expect(record.deltas.dau).toBe(-20)
    expect(record.deltas.sessions).toBe(100)
    expect(record.toolTrend).toHaveLength(14)
    expect(record.toolTrend[13]).toBe(5)
    expect(record.toolTrend[11]).toBe(3)
    expect(record.failCauses).toEqual([{ cause: 'bad_param', count: 2 }, { cause: 'timeout', count: 1 }])
    expect(record.topTools).toEqual([{ api: 'noop_write', count: 7 }])
  })

  it('GET /agenthub/api/analytics 空集 → 零值 KPI + 持平 + 全 0 趋势 + 空集合', async () => {
    const { deps } = fakeDeps({ emptyAnalytics: true })
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/analytics'))
    expect(result.status).toBe(200)
    const record = result.json as AnalyticsRecord
    expect(record.kpi).toEqual({ dau: 0, sessions: 0, toolCalls: 0, successRate: 0, badcaseRate: 0, approvalRate: 0 })
    expect(record.deltas).toEqual({
      dau: null,
      sessions: null,
      toolCalls: null,
      successRate: null,
      badcaseRate: null,
      approvalRate: null,
    })
    expect(record.toolTrend).toEqual(new Array<number>(14).fill(0))
    expect(record.failCauses).toEqual([])
    expect(record.topTools).toEqual([])
  })

  it('GET /agenthub/api/badcases → 200 join 映射（无问答列如实留空）', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/badcases'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: BadcaseRecord[] }).items
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'b-1',
      cause: 'bad_param',
      causeDetail: '参数错',
      question: '摘要',
      answer: '摘要',
      project: '销售',
      user: '张三',
      status: 'open',
      session: 's-1',
      tool: 'query_customer',
    })
    expect(items[1]).toMatchObject({
      id: 'b-2',
      cause: 'timeout',
      causeDetail: '',
      question: '',
      answer: '',
      project: '',
      user: '',
      status: 'resolved',
      session: '',
      tool: '',
    })
  })

  it('GET /agenthub/api/admin/users → 200 角色显示名映射 + active', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/admin/users'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: UserRecord[] }).items
    expect(items[0]).toMatchObject({ id: 'u-1', name: '张三', email: 'z@x', role: 'Member、Platform Admin', active: true })
    expect(items[1]).toMatchObject({ id: 'u-2', name: '李四', role: '', active: false })
  })

  it('GET /agenthub/api/admin/roles → 200 desc 静态映射 + members + builtin', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/admin/roles'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: RoleRecord[] }).items
    expect(items.find(item => item.name === 'member')).toMatchObject({
      name: 'member',
      desc: '成员：在 Project 内发起会话、调用已分配 Tool、确认写操作',
      members: 5,
      builtin: true,
    })
    expect(items.find(item => item.name === 'platform_admin')?.members).toBe(2)
  })

  it('GET /agenthub/api/projects → 200 当前用户可见项目', async () => {
    const { deps, projects } = fakeDeps()
    projects.push({ id: PROJECT_ID, name: '销售管理系统', createdBy: USER_ID })
    const result = await handleAgenthubRequest(deps, get('/agenthub/api/projects'))
    expect(result.status).toBe(200)
    const items = (result.json as { items: ProjectOption[] }).items
    expect(items).toEqual([{ id: PROJECT_ID, name: '销售管理系统', workspaceId: 'mem:x' }])
  })

  it('POST /agenthub/api/projects → 200 创建并返回 ProjectOption（platform_admin）', async () => {
    const { deps } = fakeDeps()
    // 名称两侧空白：路由层先 trim 再进领域服务（与 SSR 表单路径同口径）。
    const result = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/projects', new URLSearchParams({ name: ' 新项目 ' })),
    )
    expect(result.status).toBe(200)
    const created = result.json as ProjectOption
    expect(created.name).toBe('新项目')
    expect(created.id).toMatch(/^[0-9a-f-]+$/)
    // 创建后出现在当前用户（创建者）可见列表。
    const list = await handleAgenthubRequest(deps, get('/agenthub/api/projects'))
    const items = (list.json as { items: ProjectOption[] }).items
    expect(items.some(item => item.name === '新项目')).toBe(true)
  })

  it('POST /agenthub/api/projects：空 name 400 / 非 platform_admin 403', async () => {
    const { deps } = fakeDeps()
    const empty = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/projects', new URLSearchParams({ name: '  ' })),
    )
    expect(empty.status).toBe(400)
    const forbidden = await handleAgenthubRequest(deps, {
      ...post('/agenthub/api/projects', new URLSearchParams({ name: 'x' })),
      user: { ...DEV_IDENTITY, roles: [] },
    })
    expect(forbidden.status).toBe(403)
  })

  it('POST /agenthub/api/tools/:id/enabled → 200 ok、落库并触发 connector 重载（C-5）', async () => {
    const { deps, toolRows, connectorReloads } = fakeDeps()
    const result = await handleAgenthubRequest(
      deps,
      post(`/agenthub/api/tools/${TOOL2_ID}/enabled`, new URLSearchParams({ enabled: 'true' })),
    )
    expect(result).toEqual({ status: 200, json: { ok: true } })
    expect(toolRows.find(row => row.id === TOOL2_ID)?.enabled).toBe(true)
    expect(connectorReloads()).toBe(1)
  })

  it('POST tools enabled：非法值 400 / 不存在 404 / 非 platform_admin 403（均不触发重载）', async () => {
    const { deps, connectorReloads } = fakeDeps()
    const bad = await handleAgenthubRequest(
      deps,
      post(`/agenthub/api/tools/${TOOL_ID}/enabled`, new URLSearchParams({ enabled: 'maybe' })),
    )
    expect(bad.status).toBe(400)
    const missing = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/tools/not-a-uuid/enabled', new URLSearchParams({ enabled: 'true' })),
    )
    expect(missing.status).toBe(404)
    const forbidden = await handleAgenthubRequest(deps, {
      ...post(`/agenthub/api/tools/${TOOL_ID}/enabled`, new URLSearchParams({ enabled: 'true' })),
      user: { ...DEV_IDENTITY, roles: [] },
    })
    expect(forbidden.status).toBe(403)
    expect(connectorReloads()).toBe(0)
  })

  it('POST /agenthub/api/tools/enable-all → 只启用该 Project 未启用的 Tool，并重载一次', async () => {
    const { deps, toolRows, connectorReloads } = fakeDeps()
    const otherProject = '66666666-6666-4666-8666-666666666666'
    const pendingId = '11111111-1111-4111-8111-333333333333'
    const tool = toolRows.find(row => row.id === TOOL_ID)
    const other = toolRows.find(row => row.id === TOOL2_ID)
    if (tool === undefined || other === undefined) throw new Error('fixture missing')
    tool.project_ids = [PROJECT_ID]
    tool.enabled = true
    other.project_ids = [otherProject]
    other.enabled = false
    toolRows.push({
      ...tool,
      id: pendingId,
      name: 'create_follow_task',
      enabled: false,
      project_ids: [PROJECT_ID],
    })
    const result = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/tools/enable-all', new URLSearchParams({ projectId: PROJECT_ID })),
    )
    expect(result).toEqual({ status: 200, json: { ok: true, updated: 1 } })
    expect(toolRows.find(row => row.id === pendingId)?.enabled).toBe(true)
    expect(toolRows.find(row => row.id === TOOL_ID)?.enabled).toBe(true)
    expect(toolRows.find(row => row.id === TOOL2_ID)?.enabled).toBe(false)
    expect(connectorReloads()).toBe(1)
  })

  it('POST tools enable-all：已全部启用不重载 / 非法 projectId 400 / 非 platform_admin 403', async () => {
    const { deps, toolRows, connectorReloads } = fakeDeps()
    for (const row of toolRows) {
      row.project_ids = [PROJECT_ID]
      row.enabled = true
    }
    const idle = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/tools/enable-all', new URLSearchParams({ projectId: PROJECT_ID })),
    )
    expect(idle).toEqual({ status: 200, json: { ok: true, updated: 0 } })
    const bad = await handleAgenthubRequest(
      deps,
      post('/agenthub/api/tools/enable-all', new URLSearchParams({ projectId: 'not-a-uuid' })),
    )
    expect(bad.status).toBe(400)
    const forbidden = await handleAgenthubRequest(deps, {
      ...post('/agenthub/api/tools/enable-all', new URLSearchParams({ projectId: PROJECT_ID })),
      user: { ...DEV_IDENTITY, roles: [] },
    })
    expect(forbidden.status).toBe(403)
    expect(connectorReloads()).toBe(0)
  })

  it('DELETE /agenthub/api/projects/:id/tools/:toolId → 只删该项目里的这条 Tool', async () => {
    const { deps, toolRows, connectorReloads } = fakeDeps()
    const owned = toolRows.find(row => row.id === TOOL_ID)
    const other = toolRows.find(row => row.id === TOOL2_ID)
    if (owned === undefined || other === undefined) throw new Error('fixture missing')
    owned.project_ids = [PROJECT_ID]
    other.project_ids = ['66666666-6666-4666-8666-666666666666']
    const result = await handleAgenthubRequest(
      deps,
      del(`/agenthub/api/projects/${PROJECT_ID}/tools/${TOOL_ID}`),
    )
    expect(result).toEqual({ status: 200, json: { id: TOOL_ID } })
    expect(toolRows.some(row => row.id === TOOL_ID)).toBe(false)
    expect(toolRows.some(row => row.id === TOOL2_ID)).toBe(true)
    expect(connectorReloads()).toBe(1)
    const missing = await handleAgenthubRequest(
      deps,
      del(`/agenthub/api/projects/${PROJECT_ID}/tools/${TOOL2_ID}`),
    )
    expect(missing.status).toBe(404)
    const forbidden = await handleAgenthubRequest(deps, {
      ...del(`/agenthub/api/projects/${PROJECT_ID}/tools/${TOOL2_ID}`),
      user: { ...DEV_IDENTITY, roles: [] },
    })
    expect(forbidden.status).toBe(403)
    expect(toolRows.some(row => row.id === TOOL2_ID)).toBe(true)
  })

  it('DELETE /agenthub/api/connections/:id → 删连接并清掉挂在它上面的 Tool', async () => {
    const { deps, toolRows, connectionIds, connectorReloads } = fakeDeps()
    const owned = toolRows.find(row => row.id === TOOL_ID)
    const other = toolRows.find(row => row.id === TOOL2_ID)
    if (owned === undefined || other === undefined) throw new Error('fixture missing')
    owned.connection_id = CONNECTION_ID
    other.connection_id = null
    const result = await handleAgenthubRequest(deps, del(`/agenthub/api/connections/${CONNECTION_ID}`))
    expect(result).toEqual({ status: 200, json: { id: CONNECTION_ID } })
    expect(connectionIds.has(CONNECTION_ID)).toBe(false)
    expect(toolRows.some(row => row.id === TOOL_ID)).toBe(false)
    expect(toolRows.some(row => row.id === TOOL2_ID)).toBe(true)
    expect(connectorReloads()).toBe(1)
    const missing = await handleAgenthubRequest(
      deps,
      del('/agenthub/api/connections/77777777-7777-4777-8777-777777777777'),
    )
    expect(missing.status).toBe(404)
  })

  it('DELETE /agenthub/api/projects/:id → 删项目、它的连接，以及只属于它的 Tool', async () => {
    const otherProject = '66666666-6666-4666-8666-666666666666'
    const sharedId = '11111111-1111-4111-8111-333333333333'
    const { deps, projects, toolRows, connectionIds, connectorReloads } = fakeDeps()
    projects.push({ id: PROJECT_ID, name: '销售管理系统', createdBy: USER_ID, connectionId: CONNECTION_ID })
    const owned = toolRows.find(row => row.id === TOOL_ID)
    const exclusive = toolRows.find(row => row.id === TOOL2_ID)
    if (owned === undefined || exclusive === undefined) throw new Error('fixture missing')
    owned.connection_id = CONNECTION_ID
    owned.project_ids = [PROJECT_ID, otherProject]
    exclusive.connection_id = null
    exclusive.project_ids = [PROJECT_ID]
    toolRows.push({
      ...exclusive,
      id: sharedId,
      name: 'shared_tool',
      project_ids: [PROJECT_ID, otherProject],
      connection_id: null,
    })
    const result = await handleAgenthubRequest(deps, del(`/agenthub/api/projects/${PROJECT_ID}`))
    expect(result).toEqual({ status: 200, json: { id: PROJECT_ID } })
    expect(projects.some(item => item.id === PROJECT_ID)).toBe(false)
    expect(connectionIds.has(CONNECTION_ID)).toBe(false)
    expect(toolRows.some(row => row.id === TOOL_ID)).toBe(false)
    expect(toolRows.some(row => row.id === TOOL2_ID)).toBe(false)
    expect(toolRows.some(row => row.id === sharedId)).toBe(true)
    expect(connectorReloads()).toBe(1)
    const missing = await handleAgenthubRequest(deps, del(`/agenthub/api/projects/${PROJECT_ID}`))
    expect(missing.status).toBe(404)
    const forbidden = await handleAgenthubRequest(deps, {
      ...del(`/agenthub/api/projects/${otherProject}`),
      user: { ...DEV_IDENTITY, roles: [] },
    })
    expect(forbidden.status).toBe(403)
  })

  it('POST /agenthub/api/connections → 200 返回 SystemConnection JSON', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(
      deps,
      post(
        '/agenthub/api/connections',
        new URLSearchParams({
          projectId: '22222222-2222-4222-8222-222222222222',
          name: 'OMS',
          baseUrl: 'https://oms.example.com',
          frontendUrl: 'https://oms.example.com/login',
          openapiUrl: 'https://oms.example.com/openapi.json',
        }),
      ),
    )
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({
      name: 'OMS',
      baseUrl: 'https://oms.example.com',
      frontendUrl: 'https://oms.example.com/login',
      authMode: 'session',
      openapiUrl: 'https://oms.example.com/openapi.json',
    })
  })

  it('POST /agenthub/api/connections/:id/scan → 200 返回 IngestReceipt', async () => {
    const { deps } = fakeDeps()
    const result = await handleAgenthubRequest(
      deps,
      post(`/agenthub/api/connections/${CONNECTION_ID}/scan`, new URLSearchParams()),
    )
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ created: ['query_customer'], total: 2 })
  })

  it('POST /agenthub/api/projects/:id/credentials → 200 仅回执（绝不回显明文）', async () => {
    const { deps, storedCredentials } = fakeDeps()
    const result = await handleAgenthubRequest(
      deps,
      post(
        `/agenthub/api/projects/${PROJECT_ID}/credentials`,
        new URLSearchParams({ systemConnectionId: 'c-1', plaintext: 'super-secret-token', externalUserId: 'ext-1' }),
      ),
    )
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ id: CREDENTIAL_ID, keyVersion: 1, expiresAt: null })
    expect(JSON.stringify(result.json)).not.toContain('super-secret-token')
    expect(storedCredentials).toEqual([{ plaintext: 'super-secret-token' }])
  })

  it('写方法与读方法错配 → 405；未知 API 路径 → 404', async () => {
    const { deps } = fakeDeps()
    const wrongMethod = await handleAgenthubRequest(deps, post('/agenthub/api/tools', new URLSearchParams()))
    expect(wrongMethod.status).toBe(405)
    const unknown = await handleAgenthubRequest(deps, get('/agenthub/api/whatever'))
    expect(unknown.status).toBe(404)
  })

  it('db / connector 未装配 → 503（U5 envelope）', async () => {
    const { deps } = fakeDeps()
    const noServices: RouterDeps = {
      auth: deps.auth,
      rbac: deps.rbac,
      project: deps.project,
      sessions: deps.sessions,
      approval: deps.approval,
    }
    const noDb = await handleAgenthubRequest(noServices, get('/agenthub/api/tools'))
    expect(noDb.status).toBe(503)
    expect((noDb.json as { code?: string }).code).toBe('agenthub/ui/ServiceUnavailable')
    const noConnector = await handleAgenthubRequest(noServices, get('/agenthub/api/connections'))
    expect(noConnector.status).toBe(503)
  })
})

describe('/agenthub/api/projects/:id/memories（阶段 C 记忆 JSON API）', () => {
  const OTHER_PROJECT = '66666666-6666-4666-8666-666666666666'
  const MEM_ACTIVE = '77777777-7777-4777-8777-777777777771'
  const MEM_CANDIDATE = '77777777-7777-4777-8777-777777777772'
  const MEM_LOCKED = '77777777-7777-4777-8777-777777777773'
  const MEM_OTHER = '77777777-7777-4777-8777-777777777774'

  function seed(world: ReturnType<typeof fakeDeps>): void {
    const row = (id: string, projectId: string, content: string, status: 'candidate' | 'active', locked = false) => ({
      id,
      projectId,
      content,
      status,
      locked,
      deleted: false,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    })
    world.memories.push(
      row(MEM_ACTIVE, PROJECT_ID, '报表口径以财务部月报为准', 'active'),
      row(MEM_CANDIDATE, PROJECT_ID, '待确认的候选', 'candidate'),
      row(MEM_LOCKED, PROJECT_ID, '锁定的事实', 'active', true),
      row(MEM_OTHER, OTHER_PROJECT, '别的项目的记忆', 'active'),
    )
  }

  const listPath = `/agenthub/api/projects/${PROJECT_ID}/memories`
  /** 记忆子路径：无 action 时是资源本身（DELETE 用），有 action 时追加动作段（POST 用）。 */
  const itemPath = (memoryId: string, action?: string): string =>
    action === undefined || action === ''
      ? `/agenthub/api/projects/${PROJECT_ID}/memories/${memoryId}`
      : `/agenthub/api/projects/${PROJECT_ID}/memories/${memoryId}/${action}`

  it('GET 列表 → 200，只含 active 记忆（候选不进列表），字段映射为 camelCase', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, get(listPath))

    expect(result.status).toBe(200)
    const items = (result.json as { items: readonly { id: string; status: string; locked: boolean }[] }).items
    expect(items.map(item => item.id).sort()).toEqual([MEM_ACTIVE, MEM_LOCKED].sort())
    expect(items.every(item => item.status === 'active')).toBe(true)
    expect(items.find(item => item.id === MEM_LOCKED)?.locked).toBe(true)
  })

  it('GET ?status=candidate → 只返回候选（管理台确认区数据源）', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, apiGet(listPath, { status: 'candidate' }))

    const items = (result.json as { items: readonly { id: string }[] }).items
    expect(items.map(item => item.id)).toEqual([MEM_CANDIDATE])
  })

  it('GET ?status=illegal → 400（拒绝非法枚举，不静默当默认）', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, apiGet(listPath, { status: 'whatever' }))
    expect(result.status).toBe(400)
    expect((result.json as { code?: string }).code).toBe('agenthub/ui/InvalidRequest')
  })

  it('GET 非本项目记忆 → 空集（BND-4：跨 Project 零泄漏）', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, get(listPath))
    const items = (result.json as { items: readonly { id: string; projectId: string }[] }).items
    expect(items.some(item => item.id === MEM_OTHER)).toBe(false)
  })

  it('POST confirm → 200，候选转 active 并进入列表', async () => {
    const world = fakeDeps()
    seed(world)
    const confirmed = await handleAgenthubRequest(world.deps, post(itemPath(MEM_CANDIDATE, 'confirm'), new URLSearchParams()))
    expect(confirmed.status).toBe(200)
    expect((confirmed.json as { status?: string }).status).toBe('active')

    const listed = await handleAgenthubRequest(world.deps, get(listPath))
    const items = (listed.json as { items: readonly { id: string }[] }).items
    expect(items.some(item => item.id === MEM_CANDIDATE)).toBe(true)
  })

  it('POST reject → 200，候选被硬删（库内不再存在）', async () => {
    const world = fakeDeps()
    seed(world)
    const rejected = await handleAgenthubRequest(world.deps, post(itemPath(MEM_CANDIDATE, 'reject'), new URLSearchParams()))
    expect(rejected.status).toBe(200)
    expect((rejected.json as { rejected?: boolean }).rejected).toBe(true)

    const candidates = await handleAgenthubRequest(world.deps, apiGet(listPath, { status: 'candidate' }))
    expect((candidates.json as { items: unknown[] }).items).toEqual([])
  })

  it('POST lock / unlock → 200 且 locked 翻转', async () => {
    const world = fakeDeps()
    seed(world)
    const locked = await handleAgenthubRequest(world.deps, post(itemPath(MEM_ACTIVE, 'lock'), new URLSearchParams()))
    expect((locked.json as { locked?: boolean }).locked).toBe(true)

    const unlocked = await handleAgenthubRequest(world.deps, post(itemPath(MEM_ACTIVE, 'unlock'), new URLSearchParams()))
    expect((unlocked.json as { locked?: boolean }).locked).toBe(false)
  })

  it('DELETE 软删 → 200，行仍在库但列表不可见', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, {
      ...get(itemPath(MEM_ACTIVE)), method: 'DELETE',
    })
    expect(result.status).toBe(200)

    const listed = await handleAgenthubRequest(world.deps, get(listPath))
    const items = (listed.json as { items: readonly { id: string }[] }).items
    expect(items.some(item => item.id === MEM_ACTIVE)).toBe(false)
    expect(world.memories.some(item => item.id === MEM_ACTIVE)).toBe(true)
  })

  it('DELETE ?hard=true → 200，物理删行', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, {
      ...apiGet(itemPath(MEM_ACTIVE), { hard: 'true' }), method: 'DELETE',
    })
    expect(result.status).toBe(200)
    expect(world.memories.some(item => item.id === MEM_ACTIVE)).toBe(false)
  })

  it('非本项目记忆 id 的写操作 → 404（D33 归属校验经 HTTP 层仍生效）', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, post(itemPath(MEM_OTHER, 'confirm'), new URLSearchParams()))
    expect(result.status).toBe(404)
    expect((result.json as { code?: string }).code).toBe('agenthub/ui/MemoryNotFound')
    // 他项目那一行不得被改动
    expect(world.memories.find(item => item.id === MEM_OTHER)?.status).toBe('active')
  })

  it('非 UUID 的 projectId / memoryId → 404', async () => {
    const world = fakeDeps()
    const badProject = await handleAgenthubRequest(world.deps, get('/agenthub/api/projects/not-a-uuid/memories'))
    expect(badProject.status).toBe(404)
    const badMemory = await handleAgenthubRequest(world.deps, post(itemPath('not-a-uuid', 'confirm'), new URLSearchParams()))
    expect(badMemory.status).toBe(404)
  })

  it('写方法与读方法错配 → 405', async () => {
    const world = fakeDeps()
    seed(world)
    const result = await handleAgenthubRequest(world.deps, post(listPath, new URLSearchParams()))
    expect(result.status).toBe(405)
  })
})

describe('/agenthub/api/audit（阶段 C3-B 审计查询 JSON API）', () => {
  it('GET 未带 projectId → 400（查询面必须显式指定项目，不允许"全部项目"）', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(world.deps, get('/agenthub/api/audit'))
    expect(result.status).toBe(400)
    expect((result.json as { code?: string }).code).toBe('agenthub/ui/InvalidRequest')
  })

  it('GET projectId 非 UUID → 404', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(world.deps, apiGet('/agenthub/api/audit', { projectId: 'nope' }))
    expect(result.status).toBe(404)
  })

  it('GET 合法 projectId → 200 且带 items 与 total（分页面）', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(world.deps, apiGet('/agenthub/api/audit', { projectId: AUDIT_PROJECT }))

    expect(result.status).toBe(200)
    const body = result.json as { items: readonly unknown[]; total: number }
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  it('GET 非法 status → 400（不静默当默认，否则页面以为筛过了）', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      apiGet('/agenthub/api/audit', { projectId: AUDIT_PROJECT, status: 'bogus' }),
    )
    expect(result.status).toBe(400)
  })

  it('GET 非法 limit / offset → 400（越界分页不得当默认）', async () => {
    const world = fakeDeps()
    const badLimit = await handleAgenthubRequest(
      world.deps,
      apiGet('/agenthub/api/audit', { projectId: AUDIT_PROJECT, limit: '-1' }),
    )
    expect(badLimit.status).toBe(400)
    const badOffset = await handleAgenthubRequest(
      world.deps,
      apiGet('/agenthub/api/audit', { projectId: AUDIT_PROJECT, offset: 'abc' }),
    )
    expect(badOffset.status).toBe(400)
  })

  it('POST → 405（读面只开放 GET）', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(world.deps, post('/agenthub/api/audit', new URLSearchParams()))
    expect(result.status).toBe(405)
  })

  it('audit 服务未装配 → 503（U5 envelope）', async () => {
    const world = fakeDeps()
    const withoutAudit: RouterDeps = {
      auth: world.deps.auth,
      rbac: world.deps.rbac,
      project: world.deps.project,
      sessions: world.deps.sessions,
      approval: world.deps.approval,
    }
    const result = await handleAgenthubRequest(
      withoutAudit,
      apiGet('/agenthub/api/audit', { projectId: AUDIT_PROJECT }),
    )
    expect(result.status).toBe(503)
    expect((result.json as { code?: string }).code).toBe('agenthub/ui/ServiceUnavailable')
  })
})

describe('/agenthub/api 坏例登记与销号（P5 阶段书 §7.1-2）', () => {
  it('POST 登记 → 200 并回放坏例行', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      post(`/agenthub/api/audit/${AUDIT_ID}/badcase`, new URLSearchParams({
        projectId: AUDIT_PROJECT,
        category: 'wrong_tool',
        note: '调错了工具',
      })),
    )

    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ auditId: AUDIT_ID, cause: 'wrong_tool', status: 'open' })
  })

  it('POST 登记缺 projectId → 400', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      post(`/agenthub/api/audit/${AUDIT_ID}/badcase`, new URLSearchParams({ category: 'wrong_tool' })),
    )

    expect(result.status).toBe(400)
  })

  it('POST 登记非法 category → 400（不静默当 unknown）', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      post(`/agenthub/api/audit/${AUDIT_ID}/badcase`, new URLSearchParams({
        projectId: AUDIT_PROJECT,
        category: 'not_a_cause',
      })),
    )

    expect(result.status).toBe(400)
  })

  it('GET 登记路由 → 405（写面只开放 POST）', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      apiGet(`/agenthub/api/audit/${AUDIT_ID}/badcase`, { projectId: AUDIT_PROJECT }),
    )

    expect(result.status).toBe(405)
  })

  it('POST 销号命中 → 200 resolved=true', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      post('/agenthub/api/badcases/77777777-7777-4777-8777-777777777777/resolve', new URLSearchParams({ projectId: AUDIT_PROJECT })),
    )

    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ id: BADCASE_ID, status: 'resolved' })
  })

  it('POST 销号未命中（跨项目或不存在）→ 404，不泄漏存在性', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(
      world.deps,
      post('/agenthub/api/badcases/88888888-0000-4000-8000-000000000000/resolve', new URLSearchParams({ projectId: AUDIT_PROJECT })),
    )

    expect(result.status).toBe(404)
  })

  it('非成员登记 → 403（fail-closed）', async () => {
    const world = fakeDeps({ member: false })
    const result = await handleAgenthubRequest(
      world.deps,
      post(`/agenthub/api/audit/${AUDIT_ID}/badcase`, new URLSearchParams({
        projectId: AUDIT_PROJECT,
        category: 'wrong_tool',
      })),
    )

    expect(result.status).toBe(403)
  })
})

describe('登录闭环 API（会话登记 / 登录状态 / 签发入口）', () => {
  it('POST /projects/:id/chat 在打开工作区后登记会话主人', async () => {
    const world = fakeDeps()
    world.projects.push({ id: PROJECT_ID, name: '销售', createdBy: USER_ID })
    const result = await handleAgenthubRequest(
      world.deps,
      post(`/agenthub/api/projects/${PROJECT_ID}/chat`, new URLSearchParams()),
    )
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ workspaceId: `mem:${PROJECT_ID}`, workspacePath: `/data/${PROJECT_ID}` })
    expect(world.chatIntents).toEqual([{ projectId: PROJECT_ID, userId: USER_ID }])
  })

  it('GET /business-tools 只返回当前员工所属项目的连接器工具名', async () => {
    const world = fakeDeps()
    const result = await handleAgenthubRequest(world.deps, apiGet('/agenthub/api/business-tools'))
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ items: ['writeAnything'] })
  })

  it('GET /login-state：成员看到连接名与 missing，响应不含凭证', async () => {
    const world = fakeDeps()
    world.projects.push({ id: PROJECT_ID, name: '销售', createdBy: USER_ID })
    const result = await handleAgenthubRequest(
      world.deps,
      apiGet('/agenthub/api/login-state', { tool: 'writeAnything', cwd: `/data/${PROJECT_ID}` }),
    )
    expect(result.status).toBe(200)
    expect(result.json).toEqual({
      connectionId: CONNECTION_ID,
      connectionName: 'CRM Production',
      status: 'missing',
    })
    expect(JSON.stringify(result.json)).not.toMatch(/token|password|secret|ticket/i)
  })

  it('GET /login-state：工具不属于该项目 → 404，不泄露其他连接', async () => {
    const world = fakeDeps()
    world.projects.push({ id: PROJECT_ID, name: '销售', createdBy: USER_ID })
    const result = await handleAgenthubRequest(
      world.deps,
      apiGet('/agenthub/api/login-state', { tool: 'other.tool', cwd: `/data/${PROJECT_ID}` }),
    )
    expect(result.status).toBe(404)
  })

  it('GET /login-state：非成员 → 403', async () => {
    const world = fakeDeps()
    world.projects.push({ id: PROJECT_ID, name: '销售', createdBy: 'someone-else' })
    const result = await handleAgenthubRequest(
      world.deps,
      apiGet('/agenthub/api/login-state', { tool: 'writeAnything', cwd: `/data/${PROJECT_ID}` }),
    )
    expect(result.status).toBe(403)
  })

  it('POST /connections/:id/login：成员拿到登录站点入口；非成员 403', async () => {
    const member = fakeDeps()
    const allowed = await handleAgenthubRequest(
      member.deps,
      post(`/agenthub/api/connections/${CONNECTION_ID}/login`, new URLSearchParams()),
    )
    expect(allowed.status).toBe(200)
    expect(allowed.json).toEqual({
      url: `http://login.test:5080/agenthub/connections/${CONNECTION_ID}/enter?ticket=${USER_ID.slice(0, 8)}`,
    })

    const outsider = fakeDeps({ member: false })
    const denied = await handleAgenthubRequest(
      outsider.deps,
      post(`/agenthub/api/connections/${CONNECTION_ID}/login`, new URLSearchParams()),
    )
    expect(denied.status).toBe(403)
    expect((denied.json as { code: string }).code).toBe('agenthub/system-connector/ProxyForbidden')
  })
})
