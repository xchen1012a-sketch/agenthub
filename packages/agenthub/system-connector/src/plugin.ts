/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P3 方案书阶段 C T6）。
 *
 * 装配流程：
 * 1. `system_connections` CRUD 服务 → provide `agenthub/system-connector`（JSON API 与登录中转消费）；
 * 2. connector Tool 注册（enabled openapi 工具的执行体，resolveCredential → fetch）；
 * 3. 侧边浏览器登录：按配置的登录站点装配票据与中转会话，注册
 *    `/agenthub/connections/<id>/{authorize,enter,s/<sid>/*}`——webServer 装配后注册。
 *
 * 依赖：db（auth provide）/ vault（credential-vault）/ auth（主站登录态，签发票据）/
 * tool-scope（Session 绑定，执行体身份来源）/ tools（Tool Registry）。
 *
 * @module @agenthub/system-connector/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { AGENTHUB_EVENTS, createLogger, type Queryable } from '@agenthub/_shared'
import { LoginDesk } from './login-session.ts'
import { createAuthorizeHandler } from './proxy.ts'
import { SystemConnectorService } from './service.ts'
import { ConnectorToolRegistry } from './tools.ts'
import type { ConnectorIdentityResolver, ConnectorScopeLookup, ConnectorTokenSource } from './types.ts'

export const name = '@agenthub/system-connector' as const

/** 插件配置（agenthub.yaml 中本插件的 config 段）。 */
export interface Config {
  /**
   * 登录站点源，例如 `http://localhost:5080`。必须与员工打开平台所用的地址不同站，
   * 侧边浏览器才会打开它；同一服务换一个主机名即可。留空则平台内登录不可用。
   */
  readonly loginOrigin: string
}

export const Config = z.object({
  loginOrigin: z.string().default(''),
})

/** 必需服务（webServer 为可选装配：无 webServer 时仅不注册登录路由）。 */
export const inject = [
  'agenthub/db',
  'agenthub/vault',
  'agenthub/auth',
  'agenthub/tool-scope',
  'tools',
] as const

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['agenthub/db', 'agenthub/vault', 'agenthub/auth', 'agenthub/tool-scope', 'tools'], (injected) => {
    const logger = createLogger('agenthub/system-connector')
    const db = injected.get('agenthub/db') as Queryable
    const vault = injected.get('agenthub/vault') as ConnectorTokenSource
    const auth = injected.get('agenthub/auth') as ConnectorIdentityResolver
    const scopes = injected.get('agenthub/tool-scope') as ConnectorScopeLookup
    const service = new SystemConnectorService(db)
    const desk = new LoginDesk({ origin: config.loginOrigin.trim() === '' ? null : config.loginOrigin.trim() })
    service.configureLogin(desk)
    const registry = new ConnectorToolRegistry({
      db,
      vault,
      scopes,
      onTokenRequired: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.externalSystemTokenRequired, payload)
      },
      onDenied: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.toolDenied, payload)
      },
    })
    ctx.provide('agenthub/system-connector', service)
    // C-5：把运行期重载能力接到 service（管理台启停 Tool 后由 ui 调用 reloadTools 生效）。
    service.setToolReloader(() => registry.load(ctx))
    // connector Tool 注册：DB 读取失败不阻断启动（该 Project 尚无连接即 0 行）。
    void registry.load(ctx).catch((error: unknown) => {
      logger.error(
        { event: 'connector.tools-load-failed', projectId: null, userId: null, traceId: null, sessionId: null },
        { message: error instanceof Error ? error.message : String(error) },
      )
    })
    if (desk.loginHost === null) {
      logger.warn({ event: 'connector.login-origin-missing', projectId: null, userId: null, traceId: null, sessionId: null }, {})
    }
    // 登录路由：webServer 装配后生效（测试/无 web 场景不提供该服务，回调不触发）。
    ctx.inject(['webServer'], (withWeb) => {
      const webServer = withWeb.get('webServer') as Context['webServer']
      webServer.register({
        kind: 'prefix',
        path: '/agenthub/connections',
        handler: createAuthorizeHandler({ service, vault, auth, desk }),
      })
      logger.info({ event: 'connector.authorize-route-registered', projectId: null, userId: null, traceId: null, sessionId: null }, { loginHost: desk.loginHost })
    })
    logger.info({ event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null }, {})
  })
}
