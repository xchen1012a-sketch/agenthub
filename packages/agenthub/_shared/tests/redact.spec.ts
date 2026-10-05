import { describe, expect, it } from 'vitest'
import { AUDIT_ALLOWED_FIELDS, AUDIT_DENIED_FIELDS, REDACTED, redact, redactArgs, redactText } from '../src/index.ts'

describe('凭证脱敏（V5）', () => {
  it('redactText 覆盖 k=v 与 k:v 形式', () => {
    expect(redactText('password=abc123')).toBe('password=***')
    expect(redactText('token: abc')).toBe('token=***')
    expect(redactText('api_key=xyz')).toBe('api_key=***')
    expect(redactText('AGENTHUB_VAULT_MASTER_KEY=zzz')).toBe('AGENTHUB_VAULT_MASTER_KEY=***')
  })

  it('非敏感键值原样保留', () => {
    expect(redactText('name=cjhua project=agenthub')).toBe('name=cjhua project=agenthub')
  })

  it('同一行多个敏感片段全部替换', () => {
    expect(redactText('token=a password=b')).toBe('token=*** password=***')
  })

  it('对象深度遍历：敏感键整体替换，嵌套与数组同样生效', () => {
    expect(
      redact({
        token: 't',
        nested: { apiKey: 'k', keep: 'v' },
        list: [{ secret: 's' }, 'plain'],
        ok: 1,
      }),
    ).toEqual({
      token: '***',
      nested: { apiKey: '***', keep: 'v' },
      list: [{ secret: '***' }, 'plain'],
      ok: 1,
    })
  })

  it('字符串值内的 k=v 同样被脱敏；哨兵值为 ***', () => {
    expect(redact('password=hunter2')).toBe('password=***')
    expect(REDACTED).toBe('***')
  })

  it('复合命名键命中后缀规则（.ai-spec 20-security.md SEC-1 绕过类封闭）', () => {
    expect(
      redact({ access_token: 'a', userToken: 'b', clientSecret: 'c', 'X-Api-Key': 'd', keep: 'v' }),
    ).toEqual({ access_token: '***', userToken: '***', clientSecret: '***', 'X-Api-Key': '***', keep: 'v' })
  })

  it('字符串内 JSON 形态的敏感键值同样脱敏（过杀方向安全）', () => {
    expect(redactText('{"token":"abc"}')).toBe('{"token"=***')
  })

  it('冒号空格形态：值与下一 token 一并吞掉，不残留明文', () => {
    expect(redactText('token: abc')).toBe('token=***')
    expect(redactText('password: hunter2')).toBe('password=***')
  })

  it('多敏感字段邻接（k:v / k=v 混排）全部脱敏，无明文泄漏', () => {
    expect(redactText('token=a password:b')).toBe('token=*** password=***')
    expect(redactText('api_key=xyz password=foo')).toBe('api_key=*** password=***')
  })

  it('原始值兜底：null / 数字 / 布尔原样返回', () => {
    expect(redact(null)).toBeNull()
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
  })
})

describe('审计 args 白名单双过滤（.ai-spec 20-security.md SEC-1 MUST / A-1）', () => {
  it('常量集合导出且黑名单与 SENSITIVE_FIELDS 同源', () => {
    expect(AUDIT_ALLOWED_FIELDS.has('query')).toBe(true)
    expect(AUDIT_DENIED_FIELDS.has('token')).toBe(true)
    expect(AUDIT_DENIED_FIELDS.has('password')).toBe(true)
  })

  it('非白名单键被丢弃（默认拒绝），白名单键保留', () => {
    expect(redactArgs({ query: 'abc', page: 1, unknown_field: 'x', other: 2 })).toEqual({ query: 'abc', page: 1 })
  })

  it('黑名单字段兜底置 ***（优先于白名单判定）', () => {
    expect(redactArgs({ token: 't', api_key: 'k', password: 'p' })).toEqual({
      token: '***',
      api_key: '***',
      password: '***',
    })
  })

  it('嵌套对象递归白名单过滤；数组逐元素过滤', () => {
    expect(
      redactArgs({
        query: { keyword: 'keep', secret: 's', drop_me: 'd' },
        fields: [{ id: 1, token: 't', extra: 'e' }, 'plain=1', 7],
        not_allowed: { query: 'x' },
      }),
    ).toEqual({
      query: { keyword: 'keep', secret: '***' },
      fields: [{ id: 1, token: '***' }, 'plain=1', 7],
    })
  })

  it('顶层非白名单键整体丢弃（含其嵌套内容）', () => {
    expect(redactArgs({ list: [{ id: 1 }], query: 'q' })).toEqual({ query: 'q' })
  })

  it('大小写 / 连字符归一：白名单命中，黑名单命中', () => {
    expect(redactArgs({ Query: 'a', 'Page-Size': 5, API_KEY: 'x', Authorization: 'y' })).toEqual({
      Query: 'a',
      'Page-Size': 5,
      API_KEY: '***',
      Authorization: '***',
    })
  })

  it('字符串值过 redactText 二次兜底（k=v 片段）', () => {
    expect(redactArgs({ query: 'token=abc' })).toEqual({ query: 'token=***' })
    expect(redactArgs('token=abc')).toBe('token=***')
  })

  it('Date / 原始值透传，非对象非字符串原样返回', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    expect(redactArgs(date)).toBe(date)
    expect(redactArgs(null)).toBeNull()
    expect(redactArgs(42)).toBe(42)
  })

  it('REDACTED 哨兵复用', () => {
    expect(redactArgs({ token: 'x' })).toEqual({ token: REDACTED })
  })
})
