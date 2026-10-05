/**
 * per-Session Tool 可见性隔离（P2 方案书 T6 scope.ts / D2 处置）。
 *
 * 上游无 per-session 注册 API；可见性靠 `scope.ctx.tools.restrict({ allow })`
 * 实现（S1 结论，先例 packages/core/tools/tests/scoped.spec.ts restrict 段）：
 * 3 个手动 Tool 注册到全局 Registry，每个 Session 打开时按其 Project Tool Set
 * 计算 allow 列表并注入 restriction（restriction 相交，先 lift 旧的可切换）。
 * fail-closed：Tool Set 为空 → allow 为空列表 → 全禁。
 *
 * @module @agenthub/project-tool-scope/scope
 */
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { createLogger, type Logger } from '@agenthub/_shared'
import { ChatIntents, type ChatClaim } from './chat-intent.ts'
import type { ToolCatalog } from './loader.ts'
import type { SessionBinding } from './types.ts'

/** 一个已隔离 Session 的句柄：restriction 的唯一属主。 */
export class SessionToolScope {
  /** 解除当前 restriction（refresh 时先 lift 再重挂）。 */
  private lift: () => void

  constructor(
    readonly binding: SessionBinding,
    readonly scope: Scope,
    lift: () => void,
  ) {
    this.lift = lift
  }

  /** Project Tool Set 变更 / Project 切换后重算 allow 列表（先解除旧 restriction）。 */
  async refresh(catalog: ToolCatalog, ctx: Context): Promise<void> {
    this.lift()
    this.lift = await applyRestriction(ctx, this.scope, catalog, this.binding.projectId)
  }

  /** 解除 scope（restriction 随 scope 一并 unwind）。 */
  async dispose(): Promise<void> {
    await this.scope.dispose()
  }
}

/** 计算 allow 列表并注入 restriction；只保留 Registry 已知名，防 DB-only 名炸 restrict。 */
async function applyRestriction(
  ctx: Context,
  scope: Scope,
  catalog: ToolCatalog,
  projectId: string,
): Promise<() => void> {
  const configured = await catalog.allowedToolNames(projectId)
  const known = new Set(ctx.tools.schemas().map(schema => schema.name))
  const allow = configured.filter(name => known.has(name))
  return scope.ctx.tools.restrict({ allow })
}

/**
 * Session Tool scope 服务：open 登记 binding + 注入 restriction；hooks.ts 经
 * `bindingOf(exec.agent)` 补齐身份/项目上下文（身份在 open 时由服务端传入，
 * .ai-spec 20-security.md BND-2：模型入参不可决定）。
 */
export class SessionToolScopeService {
  private readonly logger: Logger
  /** scope key（agent 对象，身份比对）→ 已隔离 Session。 */
  private readonly sessions = new Map<object, SessionToolScope>()
  /** 未绑定会话：只挂「隐藏业务 Tool」的 restriction，不登记身份。 */
  private readonly hidden = new Map<object, Scope>()
  private readonly intents: ChatIntents

  constructor(
    private readonly ctx: Context,
    private readonly catalog: ToolCatalog,
    now: () => number = Date.now,
  ) {
    this.logger = createLogger('agenthub/project-tool-scope/scope')
    this.intents = new ChatIntents(now)
  }

  /** 员工打开某项目对话时登记；调用方须已按服务端登录态核验成员关系。 */
  expectChat(projectId: string, userId: string): void {
    this.intents.expect(projectId, userId)
  }

  /** 新会话落到某项目时取走登记（见 chat-intent.ts）。 */
  claimChat(projectId: string): ChatClaim {
    return this.intents.claim(projectId)
  }

  /**
   * 未绑定会话隐藏全部业务 Tool（项目 Tool 与连接器 Tool），模型看不到也调不到；
   * 平台自带的通用 Tool 不受影响。
   */
  async hide(key: object, sessionId: string): Promise<void> {
    if (this.sessions.has(key) || this.hidden.has(key)) return
    const scope = await this.mint(key)
    const known = new Set(this.ctx.tools.schemas().map(schema => schema.name))
    const deny = (await this.catalog.businessToolNames()).filter(name => known.has(name))
    if (deny.length > 0) scope.ctx.tools.restrict({ deny })
    this.hidden.set(key, scope)
    this.logger.info(
      { event: 'tool-scope.hidden', projectId: null, userId: null, traceId: null, sessionId },
      { hiddenTools: deny.length },
    )
  }

  private async mint(key: object): Promise<Scope> {
    let scope!: Scope
    await this.ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, key)
    }, { inject: ['tools'] }))
    return scope
  }

  /** 读 Session 绑定（未绑定 / 未 open → null，hooks 不发事件）。 */
  bindingOf(key: object | undefined): SessionToolScope | null {
    if (key === undefined) return null
    return this.sessions.get(key) ?? null
  }

  /**
   * 打开一个 Session 的 Project Tool scope（V4 隔离核心）。
   * createScope 镜像上游 mintAgentScope 先例：scoped context 继承铸造插件的
   * 依赖链，铸造方必须 inject `tools`。
   */
  async open(projectId: string, userId: string, sessionId: string, key: object): Promise<SessionToolScope> {
    const existing = this.sessions.get(key)
    if (existing !== undefined) {
      throw new Error(`agenthub/project-tool-scope: session scope already open (sessionId=${sessionId})`)
    }
    if (this.hidden.has(key)) {
      throw new Error(`agenthub/project-tool-scope: session already opened unbound (sessionId=${sessionId})`)
    }
    const scope = await this.mint(key)
    const lift = await applyRestriction(this.ctx, scope, this.catalog, projectId)
    const handle = new SessionToolScope({ projectId, userId, sessionId }, scope, lift)
    this.sessions.set(key, handle)
    this.logger.info(
      { event: 'tool-scope.opened', projectId, userId, traceId: null, sessionId },
      {},
    )
    return handle
  }

  /** Session 关闭：解除隔离并移除绑定。 */
  async close(key: object): Promise<void> {
    const hidden = this.hidden.get(key)
    if (hidden !== undefined) {
      this.hidden.delete(key)
      await hidden.dispose()
    }
    const handle = this.sessions.get(key)
    if (handle === undefined) return
    this.sessions.delete(key)
    await handle.dispose()
    this.logger.info(
      { event: 'tool-scope.closed', projectId: handle.binding.projectId, userId: handle.binding.userId, traceId: null, sessionId: handle.binding.sessionId },
      {},
    )
  }
}
