/**
 * connector Tool 执行体注册（P3 方案书阶段 C T6 / §4.3）。
 *
 * 对「`source = 'openapi'` 且 `enabled = true` 且挂着 system_connection」的行注册真实 Cordis Tool
 * （计划书 §4.3）：管理台启停后由 `load` 重载（先释放旧注册再按当前 enabled 重注册，幂等无重复 / 泄漏），
 * 无需重启即生效。执行体内仍惰性校验 `tools.enabled`（fail-closed），覆盖「DB 已改、重载未完成」窗口
 * → `vault.resolveCredential` → fetch 外部系统 → 结果回上游事件流。Project 可见性仍由
 * @agenthub/project-tool-scope 的 per-Session `restrict` 收敛（本注册不感知 Project）。
 *
 * `tools.source_ref` 约定为 `"<METHOD> <path>"`（openapi-ingest 写入），执行体据此
 * 还原 HTTP 调用；P3 仅支持基础 method/path + 参数直传（GET → query，其余 → JSON body）。
 *
 * 硬边界（security.md §1.1 / 计划书 §8）：请求目标域必须与该连接的 base_url **同源**，
 * 否则拒绝且**不发请求**（凭证绝不外发到非目标域）。
 *
 * 阻断分支向 audit 发 `tool.denied`（reason 闭集见 _shared/events.ts，D16）。
 *
 * @module @agenthub/system-connector/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  AgenthubError,
  createLogger,
  isAgenthubError,
  isOutboundTargetAllowed,
  type ExternalSystemTokenRequiredPayload,
  type Logger,
  type Queryable,
  type ToolDeniedPayload,
} from '@agenthub/_shared'
import { AUTHORIZATION, COOKIE } from './carrier.ts'
import { LoginRequiredError } from './errors.ts'
import type { ConnectorBinding, ConnectorScopeLookup, ConnectorTokenSource } from './types.ts'

/** 一条可注册的 connector Tool 行（tools JOIN system_connections）。 */
export interface ConnectorToolRow {
  id: string
  name: string
  description: string
  parameters: unknown
  source_ref: string | null
  connection_id: string
  /** 连接名称，只用于提示员工登录哪个系统；缺省时用连接 id。 */
  connection_name?: string
  base_url: string
  auth_mode: string
  /** 缺省按空名单处理：内网目标拒绝。 */
  allowed_hosts?: readonly string[]
}

export interface ConnectorToolRegistryDeps {
  readonly db: Queryable
  readonly vault: ConnectorTokenSource
  readonly scopes: ConnectorScopeLookup
  /** `external-system.token-required` 出口（插件接 ctx.emit）。 */
  readonly onTokenRequired: (payload: ExternalSystemTokenRequiredPayload) => void
  /** `tool.denied` 出口（插件接 ctx.emit）。 */
  readonly onDenied: (payload: ToolDeniedPayload) => void
  /** fetch 注入（测试用 mock 或断言替身）。 */
  readonly fetchImpl?: typeof fetch
  readonly logger?: Logger
}

const DEFAULT_METHOD = 'GET'
const DEFAULT_PATH = '/'

/** `"POST /write-anything"` → method/path；非法/缺失回退 GET /。 */
export function parseOperationRef(sourceRef: string | null): { method: string; path: string } {
  if (sourceRef === null) return { method: DEFAULT_METHOD, path: DEFAULT_PATH }
  const match = /^([A-Z]+)\s+(\S+)$/.exec(sourceRef.trim())
  if (match === null) return { method: DEFAULT_METHOD, path: DEFAULT_PATH }
  return { method: match[1] as string, path: match[2] as string }
}

export class ConnectorToolRegistry {
  private readonly logger: Logger
  private readonly fetchImpl: typeof fetch
  /** 本包已注册 Tool 的 disposer 集合（load 重载前先释放，避免重复注册 / 泄漏）。 */
  private disposers: Array<() => void> = []

  constructor(private readonly deps: ConnectorToolRegistryDeps) {
    this.logger = deps.logger ?? createLogger('agenthub/system-connector/tools')
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  /**
   * 按当前 `enabled = true AND source = 'openapi'` 注册 connector Tool（计划书 §4.3）。
   *
   * 重载语义：先释放本包旧注册（`disposeAll`）再重新注册——管理台启停后调用即生效，
   * 幂等（不会重复注册 / 泄漏）；查询失败时旧注册已释放，保持 fail-closed。
   */
  async load(ctx: Context): Promise<void> {
    this.disposeAll()
    const { rows } = await this.deps.db.query<ConnectorToolRow>(
      'SELECT t.id, t.name, t.description, t.parameters, t.source_ref,'
      + ' c.id AS connection_id, c.name AS connection_name, c.base_url, c.auth_mode, c.allowed_hosts'
      + ' FROM tools t JOIN system_connections c ON c.id = t.system_connection_id'
      + " WHERE t.source = 'openapi' AND t.enabled = true",
      [],
    )
    this.disposers = rows.map(row => ctx.tools.register(this.definition(row)))
    this.logger.info(
      { event: 'connector.tools-registered', projectId: null, userId: null, traceId: null, sessionId: null },
      { count: rows.length },
    )
  }

  /** 释放本包已注册的全部 connector Tool（dispose 幂等，可重复调用）。 */
  disposeAll(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  /** 单个 connector Tool 定义（execute 全分支：凭证缺失/过期、上游 403、成功）。 */
  definition(row: ConnectorToolRow): ToolDefinition {
    const { method, path } = parseOperationRef(row.source_ref)
    return {
      name: row.name,
      description: row.description,
      parameters: row.parameters as ToolDefinition['parameters'],
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
      },
      execute: async (args, exec) => {
        const handle = this.deps.scopes.bindingOf(exec.agent)
        if (handle === null) {
          throw new AgenthubError(
            'agenthub/system-connector/Unauthenticated',
            '工具调用缺少 Session 绑定，拒绝执行',
            { httpStatus: 401 },
          )
        }
        const binding = handle.binding
        // C-5：重载窗口守卫——注册集是 load 时刻快照，DB 改动到 reload 完成前旧 Tool 仍可被调用。
        const enabled = await this.isEnabled(row.id)
        if (!enabled) {
          this.deny(row, binding, 'denied:tool_disabled')
          throw new AgenthubError(
            'agenthub/system-connector/ToolDisabled',
            `工具未启用，拒绝执行：${row.name}`,
            { httpStatus: 403 },
          )
        }
        const credential = await this.resolveCredentialOrDeny(row, binding)
        return await this.invoke(row, method, path, args, credential, binding)
      },
    }
  }

  /**
   * 执行期惰性读启用态：未登记 / 查询失败 / enabled=false 一律视为未启用（fail-closed）。
   *
   * 保留理由（非死代码）：注册集是 load 时刻的快照，「管理台改 enabled 落库」与「reloadTools
   * 完成」之间存在窗口，且跨实例 / 直接改库不会触发本进程重载——窗口内旧 Tool 仍在 ctx.tools
   * 中，若无此守卫会用已禁用 Tool 的凭证打到外部系统。
   */
  private async isEnabled(toolId: string): Promise<boolean> {
    const { rows } = await this.deps.db.query<{ enabled: boolean }>(
      'SELECT enabled FROM tools WHERE id = $1',
      [toolId],
    )
    return rows[0]?.enabled === true
  }

  /**
   * 取凭证。缺失 → token-required + denied:credential_missing；过期 → denied:credential_expired。
   * 两种情况都抛 LoginRequiredError，对话据此出现登录卡片；不发任何外部请求（BND-3）。
   */
  private async resolveCredentialOrDeny(
    row: ConnectorToolRow,
    binding: ConnectorBinding,
  ): Promise<{ plaintext: string; carrier: string | null }> {
    try {
      return await this.deps.vault.resolveCredential(binding.userId, row.connection_id)
    } catch (error) {
      const code = isAgenthubError(error) ? error.code : ''
      if (code === 'agenthub/credential-vault/TokenMissing') {
        this.requireLogin(row, binding)
        this.deny(row, binding, 'denied:credential_missing')
        throw new LoginRequiredError(this.connectionLabel(row), row.name, false)
      }
      if (code === 'agenthub/credential-vault/TokenExpired') {
        this.requireLogin(row, binding)
        this.deny(row, binding, 'denied:credential_expired')
        throw new LoginRequiredError(this.connectionLabel(row), row.name, true)
      }
      throw error
    }
  }

  private requireLogin(row: ConnectorToolRow, binding: ConnectorBinding): void {
    this.deps.onTokenRequired({
      userId: binding.userId,
      systemConnectionId: row.connection_id,
      toolId: row.name,
      projectId: binding.projectId,
    })
  }

  private connectionLabel(row: ConnectorToolRow): string {
    return row.connection_name ?? row.connection_id
  }

  /**
   * 真实调用：凭证按登录时记下的携带位置注入；没有记录时按 auth_mode（session → Cookie，其余 → 授权头）。
   * 目标域异源 → 拒绝不发请求；401 → 凭证记为失效并要求重新登录；403 → denied:upstream_403。
   */
  private async invoke(
    row: ConnectorToolRow,
    method: string,
    path: string,
    args: unknown,
    credential: { plaintext: string; carrier: string | null },
    binding: ConnectorBinding,
  ): Promise<unknown> {
    const base = new URL(row.base_url)
    if (!isOutboundTargetAllowed(base.hostname, row.allowed_hosts ?? [])) {
      this.deny(row, binding, 'denied:upstream_403')
      throw new AgenthubError(
        'agenthub/system-connector/NotAllowlisted',
        `内网地址尚未放行：${base.hostname}。请在该连接的白名单页放入对应主机后再继续`,
        { httpStatus: 409 },
      )
    }
    const url = new URL(path, row.base_url)
    // C-1 硬边界：path 来自 OpenAPI 原始键，可能写成 `//attacker/x` / `https://attacker/x`
    // 逃逸到攻击域——组装后必须与 base_url 同源，否则拒绝并且不注入凭证、不发请求。
    if (url.origin !== base.origin) {
      this.deny(row, binding, 'denied:origin_mismatch')
      throw new AgenthubError(
        'agenthub/system-connector/OriginDenied',
        `请求目标域与连接 base_url 异源，拒绝：${row.name}`,
        { httpStatus: 403 },
      )
    }
    const argsObj = (args ?? {}) as Record<string, unknown>
    const headers: Record<string, string> = { accept: 'application/json' }
    // 凭证仅注入本次外部请求，用后不驻留（SEC-2）。
    const carrier = credential.carrier ?? (row.auth_mode === 'session' ? COOKIE : AUTHORIZATION)
    headers[carrier] = credential.plaintext
    if (method === 'GET') {
      for (const [key, value] of Object.entries(argsObj)) url.searchParams.set(key, String(value))
    } else {
      headers['content-type'] = 'application/json'
    }
    const init: RequestInit = { method, headers }
    if (method !== 'GET') init.body = JSON.stringify(argsObj)
    const response = await this.fetchImpl(url, init)
    this.logger.info(
      { event: 'connector.invoke', projectId: binding.projectId, userId: binding.userId, traceId: null, sessionId: binding.sessionId },
      { toolName: row.name, connectionId: row.connection_id, status: response.status },
    )
    if (response.status === 401) {
      await this.deps.vault.expireCredential(binding.userId, row.connection_id)
      this.requireLogin(row, binding)
      this.deny(row, binding, 'denied:credential_expired')
      throw new LoginRequiredError(this.connectionLabel(row), row.name, true)
    }
    if (response.status === 403) {
      this.deny(row, binding, 'denied:upstream_403')
      throw new AgenthubError(
        'agenthub/system-connector/UpstreamForbidden',
        `外部系统拒绝调用（403）：${row.name}`,
        { httpStatus: 403 },
      )
    }
    if (!response.ok) {
      throw new AgenthubError(
        'agenthub/system-connector/UpstreamError',
        `外部系统返回 ${response.status}：${row.name}`,
        { httpStatus: 502 },
      )
    }
    return await response.json()
  }

  private deny(row: ConnectorToolRow, binding: ConnectorBinding, reason: string): void {
    this.deps.onDenied({
      toolId: row.name,
      projectId: binding.projectId,
      userId: binding.userId,
      sessionId: binding.sessionId,
      reason,
    })
  }
}
