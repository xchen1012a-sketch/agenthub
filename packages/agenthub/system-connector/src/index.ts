/**
 * @agenthub/system-connector —— 外部系统连接器（P3 方案书阶段 C T6）。
 *
 * - `system_connections` CRUD（0004 表首次接服务）；
 * - connector Tool 执行体（resolveCredential → fetch；缺失/过期/401 要求登录，403 分支发 `tool.denied`）；
 * - 侧边浏览器登录中转（主站 `/authorize` 签票 → 登录站点 `/enter` 换会话 → `/s/<sid>/*` 截取凭证 → vault）；
 * - `attachMCP` 薄预留（D12）。
 *
 * @module @agenthub/system-connector
 */
export { SystemConnectorService, authorizePath, proxyPath } from './service.ts'
export { ConnectorToolRegistry, parseOperationRef, type ConnectorToolRow, type ConnectorToolRegistryDeps } from './tools.ts'
export {
  createAuthorizeHandler,
  captureCookie,
  resolveProxyTarget,
  rewriteModuleImports,
  rewriteProxyHtml,
  type AuthorizeHandlerOptions,
} from './proxy.ts'
export { LoginDesk, type LoginDeskOptions, type LoginSession } from './login-session.ts'
export { credentialHeaderNames, pickCredential } from './carrier.ts'
export { LOGIN_REQUIRED_CODE, LoginRequiredError } from './errors.ts'
export { attachMCP, type AttachMcpOptions } from './mcp.ts'
export {
  AUTH_MODES,
  type AuthMode,
  type ConnectorBinding,
  type ConnectorIdentityResolver,
  type ConnectorScopeLookup,
  type ConnectorTokenSource,
  type CreateConnectionInput,
  type SystemConnection,
  type SystemConnectionRow,
  type UpdateConnectionInput,
} from './types.ts'
export { name, inject, apply, Config } from './plugin.ts'
