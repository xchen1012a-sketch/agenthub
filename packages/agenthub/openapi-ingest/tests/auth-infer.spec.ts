import { describe, expect, it } from 'vitest'
import { inferAuthMode } from '../src/auth-infer.ts'

describe('inferAuthMode', () => {
  it('oauth2 / oidc / 令牌各归其类', () => {
    expect(inferAuthMode({ components: { securitySchemes: { a: { type: 'oauth2' } } } })).toBe('oauth2')
    expect(inferAuthMode({ components: { securitySchemes: { a: { type: 'openIdConnect' } } } })).toBe('oidc')
    expect(inferAuthMode({ components: { securitySchemes: { a: { type: 'http' } } } })).toBe('pat')
  })

  it('没有声明或多种方式并存时走平台内登录', () => {
    expect(inferAuthMode({ openapi: '3.0.3' })).toBe('session')
    expect(inferAuthMode({
      components: { securitySchemes: { a: { type: 'oauth2' }, b: { type: 'apiKey' } } },
    })).toBe('session')
  })
})
