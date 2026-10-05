/**
 * 从接口文档的安全声明推断员工登录方式。
 * 没有声明，或几种方式互相矛盾时，走平台内登录。
 */

export type InferredAuthMode = 'oauth2' | 'oidc' | 'pat' | 'session'

/** 读 OpenAPI `securitySchemes`，给出一种登录方式。 */
export function inferAuthMode(doc: unknown): InferredAuthMode {
  if (doc === null || typeof doc !== 'object') return 'session'
  const schemes = (doc as {
    components?: { securitySchemes?: Record<string, { type?: unknown }> }
  }).components?.securitySchemes
  if (schemes === undefined) return 'session'
  const kinds = new Set<InferredAuthMode>()
  for (const scheme of Object.values(schemes)) {
    if (scheme.type === 'oauth2') kinds.add('oauth2')
    else if (scheme.type === 'openIdConnect') kinds.add('oidc')
    else if (scheme.type === 'apiKey' || scheme.type === 'http') kinds.add('pat')
  }
  if (kinds.size !== 1) return 'session'
  return [...kinds][0] ?? 'session'
}
