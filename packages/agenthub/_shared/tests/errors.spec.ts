import { describe, expect, it } from 'vitest'
import { AgenthubError, toErrorEnvelope } from '../src/index.ts'

const CODE = 'agenthub/auth/InvalidCredential'

describe('AgenthubError（plugin-skeleton §5.1）', () => {
  it('合法 code 正常构造，httpStatus 默认 500', () => {
    const err = new AgenthubError(CODE, '凭证无效')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AgenthubError')
    expect(err.code).toBe(CODE)
    expect(err.httpStatus).toBe(500)
  })

  it('httpStatus 与 code 解耦（REST 语义自选）', () => {
    expect(new AgenthubError(CODE, 'x', { httpStatus: 401 }).httpStatus).toBe(401)
  })

  it('code 不合 MUST 格式即构造期拦截，禁止绕过', () => {
    expect(() => new AgenthubError('auth/InvalidCredential', 'x')).toThrow(Error)
    expect(() => new AgenthubError('agenthub/auth/invalidCredential', 'x')).toThrow(Error)
    expect(() => new AgenthubError('agenthub/Auth/Invalid Credential', 'x')).toThrow(Error)
  })

  it('message 中的键值敏感片段在构造期脱敏（U5 envelope 禁含 token / 密码）', () => {
    expect(new AgenthubError(CODE, 'token=abc123 已失效').message).toBe('token=*** 已失效')
  })

  it('cause 原样保留', () => {
    const cause = new Error('root cause')
    expect(new AgenthubError(CODE, 'x', { cause }).cause).toBe(cause)
  })
})

describe('U5 错误 envelope', () => {
  it('AgenthubError 透出 code / message / traceId', () => {
    const envelope = toErrorEnvelope(new AgenthubError(CODE, '用户未绑定该系统的凭证'), 'tid-1')
    expect(envelope).toEqual({ code: CODE, message: '用户未绑定该系统的凭证', traceId: 'tid-1' })
  })

  it('非 AgenthubError fail-closed：不外泄内部细节，traceId 可空为 null', () => {
    const envelope = toErrorEnvelope(new Error('pg 连接串 postgres://user:pw@host'), null)
    expect(envelope).toEqual({
      code: 'agenthub/_shared/UnknownError',
      message: '内部错误，请联系管理员',
      traceId: null,
    })
  })
})
