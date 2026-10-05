/**
 * 类型与结构化依赖面（无逻辑）。
 *
 * 跨包依赖刻意收敛为**结构化接口**（ConnectorTokenSource / ConnectorIdentityResolver /
 * ConnectorScopeLookup）：运行期服务经 Cordis 服务名取得，类型面不 import 兄弟包，
 * 避免新增 workspace 链接（方案书阶段 C 依赖最小化）。
 *
 * @module @agenthub/system-connector/types
 */
import type { IncomingMessage } from 'node:http'

/** 0004 表 auth_mode 值域（0013 由五值扩为六值，含 D14 的 `session`）。 */
export const AUTH_MODES = ['oauth2', 'oidc', 'api_login', 'pat', 'cookie', 'session'] as const

export type AuthMode = (typeof AUTH_MODES)[number]

/** system_connections 行（snake_case；显式列名读取，禁 SELECT *）。 */
export interface SystemConnectionRow {
  id: string
  name: string
  base_url: string
  frontend_url: string
  auth_mode: string
  openapi_url: string | null
  openapi_doc: unknown
  allowed_hosts: string[]
  /** 由 projects.system_connection_id 反查；未归入项目时为 null。 */
  project_id: string | null
  created_by: string
  created_at: Date | string
  updated_at: Date | string
}

/** 对外（UI / JSON API）的连接视图：不暴露 openapi_doc 全量，仅告知是否已存。 */
export interface SystemConnection {
  id: string
  name: string
  /** 后端地址：工具调用只发往这里。 */
  baseUrl: string
  /** 前端地址：登录页经平台转开这个地址。 */
  frontendUrl: string
  /** 归属项目；未归入时为 null，此时不能扫描、不能登录、不能调用。 */
  projectId: string | null
  authMode: string
  openapiUrl: string | null
  hasOpenapiDoc: boolean
  /** 可能携带凭证的请求头名：授权头加文档声明的 apiKey 头。登录时只从这些头取凭证。 */
  credentialHeaders: readonly string[]
  /**
   * 已填写、但是内网且不在白名单里的主机。
   * 非空时登录、解析文档、调用工具都停住。
   */
  pendingHosts: readonly string[]
  /**
   * 出站目标白名单（C-4 的授权路径）。
   *
   * 空数组 = 内网 / 环回 / 链路本地 / 元数据地址全拒，即升级前的行为。
   * 项可为精确主机（`crm.internal`）或后缀通配（`*.internal`）。
   */
  allowedHosts: readonly string[]
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface CreateConnectionInput {
  userId: string
  /** 连接必须归入的项目。该项目已有连接时拒绝。 */
  projectId: string
  name: string
  /** 后端地址。 */
  baseUrl: string
  /** 前端地址。可以和后端地址相同。 */
  frontendUrl: string
  /**
   * 省略时记为 session（平台内登录）。
   * 创建表单不收集此项；文档解析成功后由服务改写。
   */
  authMode?: string
  openapiUrl?: string | null
  openapiDoc?: unknown
  /** 出站目标白名单；省略即空数组（默认全拒受限地址）。创建时可以不填。 */
  allowedHosts?: readonly string[]
}

export interface UpdateConnectionInput {
  name?: string
  baseUrl?: string
  frontendUrl?: string
  openapiUrl?: string | null
  openapiDoc?: unknown
  allowedHosts?: readonly string[]
  /** 仅供文档解析回写，不从创建表单收集。 */
  authMode?: string
}

/** 已打开 Session 的服务端绑定（身份/归属由服务端写入，模型入参不可决定）。 */
export interface ConnectorBinding {
  readonly projectId: string
  readonly userId: string
  readonly sessionId: string
}

/** Session Tool scope 的结构化依赖面（实现由 @agenthub/project-tool-scope 提供）。 */
export interface ConnectorScopeLookup {
  bindingOf(key: object | undefined): { readonly binding: ConnectorBinding } | null
}

/**
 * 凭证 Vault 的结构化依赖面（实现由 @agenthub/credential-vault 提供）。
 * 解密出的明文只允许注入外部请求，禁止进入日志/事件/审计。
 */
export interface ConnectorTokenSource {
  /** 明文与携带位置（携带位置为 null 时按连接认证方式决定）。 */
  resolveCredential(userId: string, systemConnectionId: string): Promise<{ plaintext: string; carrier: string | null }>
  /** 外部系统判定凭证失效后立即记为过期。 */
  expireCredential(userId: string, systemConnectionId: string): Promise<void>
  storeCredential(input: {
    userId: string
    systemConnectionId: string
    plaintext: string
    externalUserId?: string | null
    expiresAt?: Date | string | null
    carrier?: string | null
  }): Promise<{ id: string; keyVersion: number; expiresAt: string | null }>
}

/** 身份解析的结构化依赖面（实现由 @agenthub/auth 提供）。 */
export interface ConnectorIdentityResolver {
  resolveIdentity(req: IncomingMessage): Promise<{ userId: string; roles: readonly string[] }>
}
