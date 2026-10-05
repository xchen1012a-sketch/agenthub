/**
 * 出站目标安全判定（`.ai-spec/20-security.md` 的 C-4）。
 *
 * 出站网络**禁止**被用作进入内网的通道：私网 / 环回 / 链路本地 / 云元数据地址默认全拒。
 * 但企业控制台必须能接自建内网系统，因此提供**显式白名单**这条授权路径：
 * 管理员按连接声明目标主机后，该主机可被放行——默认仍全拒，未声明即拦。
 *
 * 本模块是**唯一实现**。此前 `openapi-ingest` 与 `system-connector` 各抄了一份
 * `isBlockedHost`，两份实现意味着两条判定会漂移；现在收敛到此处。
 *
 * @module @agenthub/_shared/host-guard
 */

/** IPv4 环回 / 私网 / 链路本地 / CGNAT / 未指定 判定。 */
function isBlockedIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false
  const [a, b] = parts.map(Number) as [number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * 判定主机是否属于默认拒绝的范围。
 * @param hostname - URL 的主机名（WHATWG URL 已把非常规 IPv4 写法归一回点分形式）。
 * @returns 属于内网 / 环回 / 链路本地 / 元数据地址时为 `true`。
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return true
  if (host.includes(':')) {
    // IPv6：环回 ::1 / 未指定 :: / 唯一本地 fc00::/7 / 链路本地 fe80::/10
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  }
  return isBlockedIPv4(host)
}

/**
 * 判定主机是否被显式白名单授权。
 *
 * 白名单项可以是**精确主机名**（`crm.internal`）或**后缀通配**（`*.internal`）。
 * 比较按小写进行；白名单**不**覆盖协议校验，也不改变「未声明即拦」的默认。
 * @param hostname - 目标主机名。
 * @param allowedHosts - 管理员为该连接声明的白名单。
 * @returns 被授权时为 `true`。
 */
export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return allowedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (entry === '') return false
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // 保留前导点，避免 `*.internal` 匹配 `evilinternal`
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return host === entry
  })
}

/**
 * 两个字符串的编辑距离（Levenshtein），用于白名单拼写提示。
 *
 * 只服务于报错文案，按短字符串朴素实现即可，不引入依赖。
 * @param a - 字符串 A。
 * @param b - 字符串 B。
 * @returns 最少增删改次数。
 */
function editDistance(a: string, b: string): number {
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
    }
    previous = current
  }
  return previous[cols - 1] ?? 0
}

/**
 * 在已授权项里找与目标主机最接近的一项，用作拼写提示。
 *
 * 动机：用户把 `localhost` 打成 `localhos`（少一个字母）时，"未在白名单中授权"
 * 这句话不足以让人发现问题——必须把**接近的那一项**指出来，否则人会反复检查
 * 地址而不是白名单。
 * @param hostname - 目标主机。
 * @param allowedHosts - 已授权项。
 * @returns 距离最近且距离不超过 2 的项；没有近似项时为 `null`。
 */
export function nearestAllowedHost(hostname: string, allowedHosts: readonly string[]): string | null {
  const host = hostname.toLowerCase()
  let best: { entry: string; distance: number } | null = null
  for (const entry of allowedHosts) {
    const distance = editDistance(host, entry.toLowerCase())
    if (distance <= 2 && (best === null || distance < best.distance)) best = { entry, distance }
  }
  return best === null || best.distance === 0 ? null : best.entry
}

/**
 * 判定一个出站目标是否可放行。
 *
 * 顺序固定：**先判是否默认拒绝，再看白名单**。非受限主机（公网地址）直接放行；
 * 受限主机只有在白名单显式授权时才放行。这样白名单无法被用来"跳过"协议校验，
 * 也不会因为将来新增受限网段而意外放开。
 * @param hostname - 目标主机名。
 * @param allowedHosts - 管理员声明的白名单。
 * @returns 可放行时为 `true`。
 */
export function isOutboundTargetAllowed(hostname: string, allowedHosts: readonly string[] = []): boolean {
  if (!isBlockedHost(hostname)) return true
  return isHostAllowed(hostname, allowedHosts)
}
