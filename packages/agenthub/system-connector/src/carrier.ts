/**
 * 凭证携带位置：外部系统前端用哪个请求头带凭证，就记哪个，调用时原样带回。
 *
 * 候选请求头只有两类：标准授权头，以及接口文档 `securitySchemes` 里声明的
 * `apiKey`（`in: header`）。文档没写的自定义头不猜。
 *
 * @module @agenthub/system-connector/carrier
 */
import type { IncomingHttpHeaders } from 'node:http'

/** 标准授权头。 */
export const AUTHORIZATION = 'authorization'
/** Cookie 携带位置的名字（与请求头同名）。 */
export const COOKIE = 'cookie'

const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 这些头由中转自己管理，即使文档声明也不当作凭证位置。 */
const RESERVED = new Set(['host', 'cookie', 'content-length', 'content-type', 'connection', 'origin', 'referer'])

/** 从接口文档读出可能携带凭证的请求头名（小写，去重，授权头在首位）。 */
export function credentialHeaderNames(openapiDoc: unknown): string[] {
  const names = [AUTHORIZATION]
  const schemes = (openapiDoc as { components?: { securitySchemes?: unknown } } | null | undefined)
    ?.components?.securitySchemes
  if (schemes === null || typeof schemes !== 'object') return names
  for (const scheme of Object.values(schemes as Record<string, unknown>)) {
    const declared = scheme as { type?: unknown; in?: unknown; name?: unknown } | null
    if (declared?.type !== 'apiKey' || declared.in !== 'header' || typeof declared.name !== 'string') continue
    const name = declared.name.trim().toLowerCase()
    if (HEADER_NAME_RE.test(name) && !RESERVED.has(name) && !names.includes(name)) names.push(name)
  }
  return names
}

/** 请求里第一个非空的凭证头；没有则为 null。 */
export function pickCredential(
  headers: IncomingHttpHeaders,
  names: readonly string[],
): { carrier: string; value: string } | null {
  for (const name of names) {
    const raw = headers[name]
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
    if (value !== '') return { carrier: name, value }
  }
  return null
}

/** 把 `a=1; b=2` 合进 Cookie 罐；返回是否有变化。 */
export function mergeCookies(jar: Map<string, string>, cookieHeader: string): boolean {
  let changed = false
  for (const pair of cookieHeader.split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (name === '' || jar.get(name) === value) continue
    jar.set(name, value)
    changed = true
  }
  return changed
}

/** Cookie 罐 → 请求头值；空罐为 null。 */
export function cookieHeaderOf(jar: ReadonlyMap<string, string>): string | null {
  if (jar.size === 0) return null
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}
