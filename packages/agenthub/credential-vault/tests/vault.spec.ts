/**
 * 凭证 Vault 服务（P3 方案书阶段 A T3 / V5.1 vault roundtrip）。
 *
 * @module tests/vault.spec
 */
import { describe, expect, it } from 'vitest'
import {
  AgenthubError,
  createLogger,
  type LogRecord,
  type LogSink,
  type Queryable,
} from '@agenthub/_shared'
import { CredentialVaultService } from '../src/index.ts'
import { FakeVaultDb } from './fakes.ts'

const USER = 'e0eeeeee-0000-4000-8000-00000000000e'
const CONN = 'c0eeeeee-0000-4000-8000-00000000000c'
const SECRET = 'my-secret-token-12345'

/** Base64(32 字节) 测试主密钥（secrets.md §2.1 格式）。 */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')

function wired(options: { masterKey?: string | undefined } = {}) {
  const db = new FakeVaultDb()
  const records: LogRecord[] = []
  const sink: LogSink = (record) => {
    records.push(record)
  }
  const expired: { userId: string; systemConnectionId: string; expiredAt: string }[] = []
  const service = new CredentialVaultService(db as unknown as Queryable, {
    masterKey: options.masterKey ?? MASTER_KEY,
    logger: createLogger('agenthub/credential-vault', { sink }),
    onCredentialExpired: (payload) => {
      expired.push(payload)
    },
  })
  return { db, service, records, expired }
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error)
}

describe('CredentialVaultService（V5.1 vault roundtrip）', () => {
  it('roundtrip：store 后 resolve 返回同一明文，key_version=1 落库且落库参数无明文', async () => {
    const { db, service } = wired()
    const stored = await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    expect(stored.keyVersion).toBe(1)
    const insert = db.statements.find(item => item.text.includes('INSERT INTO user_credentials'))
    expect(insert?.values?.[4]).toBe(1)
    const payload = insert?.values?.[3]
    expect(payload).toBeInstanceOf(Buffer)
    // 落库的是密文，明文字节不出现。
    expect((payload as Buffer).toString('utf8')).not.toContain(SECRET)
    await expect(service.resolveToken(USER, CONN)).resolves.toBe(SECRET)
  })

  it('重复绑定 UPSERT 覆盖：resolve 得到最新明文', async () => {
    const { service } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: 'old-token' })
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: 'new-token' })
    await expect(service.resolveToken(USER, CONN)).resolves.toBe('new-token')
  })

  it('空明文 roundtrip：store "" 后 resolve 返回 ""（下界为 iv+tag，不得误判损坏，A-3）', async () => {
    const { db, service } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: '' })
    const row = db.row(USER, CONN)
    if (!row) throw new Error('落库后应能读到内存行')
    // 空明文密文恰为 iv(12B) + authTag(16B)，ciphertext 长度为 0。
    expect(row.encrypted_payload).toHaveLength(28)
    await expect(service.resolveToken(USER, CONN)).resolves.toBe('')
  })

  it('密文长度不足 iv+tag：抛 DecryptFailed（损坏拦截）', async () => {
    const { db, service } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    const row = db.row(USER, CONN)
    if (!row) throw new Error('落库后应能读到内存行')
    row.encrypted_payload = row.encrypted_payload.subarray(0, 10)
    const error = await catchError(service.resolveToken(USER, CONN))
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/DecryptFailed')
  })

  it('篡改密文 1 字节：解密抛 DecryptFailed（AgenthubError）', async () => {
    const { db, service } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    const row = db.row(USER, CONN)
    if (!row) throw new Error('落库后应能读到内存行')
    const payload = row.encrypted_payload
    payload[payload.length - 1] = (payload.at(-1) ?? 0) ^ 0xff
    const error = await catchError(service.resolveToken(USER, CONN))
    expect(error).toBeInstanceOf(AgenthubError)
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/DecryptFailed')
  })

  it('过期凭证：先于解密阻断，发 credential.expired 一次且 payload 无明文', async () => {
    const { service, expired } = wired()
    await service.storeCredential({
      userId: USER,
      systemConnectionId: CONN,
      plaintext: SECRET,
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    })
    const error = await catchError(service.resolveToken(USER, CONN))
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/TokenExpired')
    expect(expired).toEqual([
      { userId: USER, systemConnectionId: CONN, expiredAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(JSON.stringify(expired)).not.toContain(SECRET)
  })

  it('未绑定凭证：TokenMissing（404），不发 expired 事件', async () => {
    const { service, expired } = wired()
    const error = await catchError(service.resolveToken(USER, CONN))
    expect(error).toBeInstanceOf(AgenthubError)
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/TokenMissing')
    expect((error as AgenthubError).httpStatus).toBe(404)
    expect(expired).toHaveLength(0)
  })

  it('KEK 缺失或解码 ≠ 32 字节：构造期抛 AgenthubError（启动失败，fail-fast）', () => {
    const db = new FakeVaultDb()
    const build = (masterKey: string | undefined): CredentialVaultService =>
      new CredentialVaultService(db as unknown as Queryable, { masterKey })
    expect(() => build(undefined)).toThrow(AgenthubError)
    expect(() => build(Buffer.alloc(16, 1).toString('base64'))).toThrow(AgenthubError)
  })

  it('全部日志与落库 SQL 参数不含明文（V5 脱敏承诺）', async () => {
    const { db, service, records } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    await service.resolveToken(USER, CONN)
    await service.deleteCredential(USER, CONN)
    const dumped = JSON.stringify(records) + JSON.stringify(db.statements)
    expect(dumped).not.toContain(SECRET)
  })

  it('deleteCredential：存在返回 true 并删行；缺失返回 false，再 resolve 得 TokenMissing', async () => {
    const { service } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    await expect(service.deleteCredential(USER, CONN)).resolves.toBe(true)
    await expect(service.deleteCredential(USER, CONN)).resolves.toBe(false)
    const error = await catchError(service.resolveToken(USER, CONN))
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/TokenMissing')
  })

  it('携带位置随凭证保存并原样取回；旧凭证没有携带位置时为 null', async () => {
    const { service } = wired()
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET, carrier: 'x-token' })
    await expect(service.resolveCredential(USER, CONN)).resolves.toEqual({ plaintext: SECRET, carrier: 'x-token' })
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    await expect(service.resolveCredential(USER, CONN)).resolves.toEqual({ plaintext: SECRET, carrier: null })
  })

  it('携带位置不是小写请求头名：拒绝保存，且不落库', async () => {
    const { db, service } = wired()
    const error = await catchError(service.storeCredential({
      userId: USER, systemConnectionId: CONN, plaintext: SECRET, carrier: 'X Token',
    }))
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/InvalidCarrier')
    expect(db.row(USER, CONN)).toBeUndefined()
  })

  it('credentialStatus：未保存 missing、有效 ready、外部判定失效后 expired', async () => {
    const { service } = wired()
    await expect(service.credentialStatus(USER, CONN)).resolves.toBe('missing')
    await service.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: SECRET })
    await expect(service.credentialStatus(USER, CONN)).resolves.toBe('ready')
    await service.expireCredential(USER, CONN)
    await expect(service.credentialStatus(USER, CONN)).resolves.toBe('expired')
    const error = await catchError(service.resolveCredential(USER, CONN))
    expect((error as AgenthubError).code).toBe('agenthub/credential-vault/TokenExpired')
  })
})
