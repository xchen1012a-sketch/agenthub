/**
 * 出站目标安全判定与显式白名单（`.ai-spec/20-security.md` 的 C-4）。
 *
 * 断言两件事：**默认全拒**不因引入白名单而放松；**授权只对白名单内的主机生效**。
 *
 * @module tests/host-guard.spec
 */
import { describe, expect, it } from 'vitest'
import { isBlockedHost, isHostAllowed, isOutboundTargetAllowed, nearestAllowedHost } from '../src/index.ts'

describe('isBlockedHost · 默认拒绝范围', () => {
  it('环回 / 私网 / 链路本地 / CGNAT / 未指定 → 受限', () => {
    for (const host of [
      'localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0',
      '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1',
      'metadata.google.internal',
    ]) {
      expect(isBlockedHost(host), host).toBe(true)
    }
  })

  it('公网地址不受限', () => {
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', '100.128.0.1']) {
      expect(isBlockedHost(host), host).toBe(false)
    }
  })

  it('方括号包裹的 IPv6 同样判定', () => {
    expect(isBlockedHost('[::1]')).toBe(true)
    expect(isBlockedHost('[2001:db8::1]')).toBe(false)
  })
})

describe('isHostAllowed · 白名单匹配', () => {
  it('精确主机命中且大小写无关', () => {
    expect(isHostAllowed('CRM.internal', ['crm.internal'])).toBe(true)
    expect(isHostAllowed('crm.internal', ['CRM.INTERNAL'])).toBe(true)
    expect(isHostAllowed('other.internal', ['crm.internal'])).toBe(false)
  })

  it('`*.` 后缀通配命中子域，且不匹配裸域与非边界后缀', () => {
    expect(isHostAllowed('a.internal', ['*.internal'])).toBe(true)
    expect(isHostAllowed('a.b.internal', ['*.internal'])).toBe(true)
    // `*.internal` 不应匹配 `internal` 本身（无子域），也不应匹配 `evilinternal`
    expect(isHostAllowed('internal', ['*.internal'])).toBe(false)
    expect(isHostAllowed('evilinternal', ['*.internal'])).toBe(false)
  })

  it('空白项被忽略，不构成放行', () => {
    expect(isHostAllowed('crm.internal', ['', '  '])).toBe(false)
  })
})

describe('isOutboundTargetAllowed · 默认全拒 + 显式授权', () => {
  it('公网地址无需白名单即放行', () => {
    expect(isOutboundTargetAllowed('example.com', [])).toBe(true)
  })

  it('受限地址在白名单为空时拒绝（升级本功能不改变原有行为）', () => {
    expect(isOutboundTargetAllowed('127.0.0.1', [])).toBe(false)
    expect(isOutboundTargetAllowed('192.168.1.1', [])).toBe(false)
    expect(isOutboundTargetAllowed('169.254.169.254', [])).toBe(false)
  })

  it('受限地址在被显式授权后放行', () => {
    expect(isOutboundTargetAllowed('127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(isOutboundTargetAllowed('a.internal', ['*.internal'])).toBe(true)
  })

  it('白名单只对它列出的主机生效，不放宽同网段其它地址', () => {
    expect(isOutboundTargetAllowed('10.1.2.3', ['10.1.2.3'])).toBe(true)
    expect(isOutboundTargetAllowed('10.1.2.4', ['10.1.2.3'])).toBe(false)
  })
})

describe('nearestAllowedHost · 拼写提示', () => {
  it('少一个字母时指出接近的那一项（localhos → localhost）', () => {
    expect(nearestAllowedHost('localhost', ['localhos'])).toBe('localhos')
  })

  it('完全一致不算近似项（那是授权命中，不是拼错）', () => {
    expect(nearestAllowedHost('localhost', ['localhost'])).toBeNull()
  })

  it('相距过远时不乱猜', () => {
    expect(nearestAllowedHost('localhost', ['api.example.com'])).toBeNull()
  })

  it('多个候选取最近的', () => {
    expect(nearestAllowedHost('localhost', ['localhos', 'localhot'])).toBe('localhos')
  })
})
