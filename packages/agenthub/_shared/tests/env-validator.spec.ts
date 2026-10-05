/**
 * 敏感环境变量集中校验（secrets.md §4 MUST / A-2）。
 *
 * @module tests/env-validator.spec
 */
import { describe, expect, it } from 'vitest'
import { AgenthubError } from '@agenthub/_shared'
import {
  DB_URL_VAR,
  MASTER_KEY_BYTES,
  REQUIRED_SENSITIVE_ENV_VARS,
  VAULT_MASTER_KEY_VAR,
  validateDbUrl,
  validateEnv,
  validateMasterKey,
  type EnvLike,
} from '../src/index.ts'

/** Base64(32 字节) 合法主密钥。 */
const MASTER_KEY = Buffer.alloc(MASTER_KEY_BYTES, 3).toString('base64')

function validEnv(): EnvLike {
  return {
    [VAULT_MASTER_KEY_VAR]: MASTER_KEY,
    [DB_URL_VAR]: 'postgres://agenthub:pw@localhost:5432/agenthub',
    AGENTHUB_LLM_API_KEY: 'llm-key',
    AGENTHUB_COOKIE_SECRET: 'cookie-secret',
  }
}

function codeOf(error: unknown): string {
  return error instanceof AgenthubError ? error.code : ''
}

describe('环境变量集中校验（secrets.md §4）', () => {
  it('必填敏感变量清单与 SSOT 命名一致（DB_PASSWORD 为条件必填不入列）', () => {
    expect(REQUIRED_SENSITIVE_ENV_VARS).toEqual([
      VAULT_MASTER_KEY_VAR,
      DB_URL_VAR,
      'AGENTHUB_LLM_API_KEY',
      'AGENTHUB_COOKIE_SECRET',
    ])
  })

  it('validateEnv：全部必填项齐备且格式合法时通过', () => {
    expect(() => { validateEnv(validEnv()) }).not.toThrow()
  })

  it('validateEnv：缺任一必填项即抛 EnvMissing，报出缺口清单', () => {
    const env = validEnv()
    delete env.AGENTHUB_LLM_API_KEY
    delete env.AGENTHUB_COOKIE_SECRET
    const error = (() => {
      try {
        validateEnv(env)
        return null
      } catch (thrown) {
        return thrown
      }
    })()
    expect(codeOf(error)).toBe('agenthub/_shared/EnvMissing')
    expect((error as AgenthubError).message).toContain('AGENTHUB_LLM_API_KEY')
    expect((error as AgenthubError).message).toContain('AGENTHUB_COOKIE_SECRET')
  })

  it('validateEnv：空白字符串视为未设置', () => {
    expect(() => { validateEnv({ ...validEnv(), AGENTHUB_LLM_API_KEY: '   ' }) }).toThrow(AgenthubError)
  })

  it('validateEnv：主密钥非法 → EnvMasterKeyInvalid；DB URL 非法 → EnvDbUrlInvalid', () => {
    expect(codeOf(tryCatch(() => { validateEnv({ ...validEnv(), [VAULT_MASTER_KEY_VAR]: 'short' }) })))
      .toBe('agenthub/_shared/EnvMasterKeyInvalid')
    expect(codeOf(tryCatch(() => { validateEnv({ ...validEnv(), [DB_URL_VAR]: 'not a url' }) })))
      .toBe('agenthub/_shared/EnvDbUrlInvalid')
  })

  it('validateMasterKey：缺失 / 空白 / 长度不符均抛错，合法返回解码字节', () => {
    expect(codeOf(tryCatch(() => validateMasterKey({})))).toBe('agenthub/_shared/EnvMasterKeyMissing')
    expect(codeOf(tryCatch(() => validateMasterKey({ [VAULT_MASTER_KEY_VAR]: '  ' }))))
      .toBe('agenthub/_shared/EnvMasterKeyMissing')
    expect(codeOf(tryCatch(() => validateMasterKey({ [VAULT_MASTER_KEY_VAR]: Buffer.alloc(16, 1).toString('base64') }))))
      .toBe('agenthub/_shared/EnvMasterKeyInvalid')
    expect(validateMasterKey({ [VAULT_MASTER_KEY_VAR]: MASTER_KEY })).toHaveLength(MASTER_KEY_BYTES)
  })

  it('validateMasterKey：支持自定义变量名', () => {
    expect(validateMasterKey({ CUSTOM_KEY: MASTER_KEY }, 'CUSTOM_KEY')).toHaveLength(MASTER_KEY_BYTES)
    expect(codeOf(tryCatch(() => validateMasterKey({}, 'CUSTOM_KEY')))).toBe('agenthub/_shared/EnvMasterKeyMissing')
  })

  it('validateDbUrl：缺失 / 不可解析 / 协议不符抛错，postgres 与 postgresql 通过', () => {
    expect(codeOf(tryCatch(() => validateDbUrl({})))).toBe('agenthub/_shared/EnvDbUrlMissing')
    expect(codeOf(tryCatch(() => validateDbUrl({ [DB_URL_VAR]: '  ' })))).toBe('agenthub/_shared/EnvDbUrlMissing')
    expect(codeOf(tryCatch(() => validateDbUrl({ [DB_URL_VAR]: 'not a url' })))).toBe('agenthub/_shared/EnvDbUrlInvalid')
    expect(codeOf(tryCatch(() => validateDbUrl({ [DB_URL_VAR]: 'http://host/db' })))).toBe('agenthub/_shared/EnvDbUrlInvalid')
    expect(validateDbUrl({ [DB_URL_VAR]: 'postgres://u:p@host:5432/db' })).toBe('postgres://u:p@host:5432/db')
    expect(validateDbUrl({ [DB_URL_VAR]: 'postgresql://u:p@host:5432/db' })).toBe('postgresql://u:p@host:5432/db')
  })

  it('validateDbUrl：支持自定义变量名', () => {
    expect(validateDbUrl({ CUSTOM_URL: 'postgres://u@h/db' }, 'CUSTOM_URL')).toBe('postgres://u@h/db')
  })
})

function tryCatch(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}
