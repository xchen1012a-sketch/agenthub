/**
 * 凭证 Vault 服务（P3 方案书阶段 A T3 / secrets.md §1.1/§2.1）。
 *
 * AES-256-GCM（node:crypto，零第三方加密依赖），密文格式 iv(12B) || authTag(16B)
 * || ciphertext。KEK = AGENTHUB_VAULT_MASTER_KEY（Base64，解码恰 32 字节），
 * 构造期校验，缺失/非法即抛 AgenthubError（插件装配失败 → 启动失败，fail-fast）。
 *
 * 不可见承诺（方案书 G2）：明文只在 resolveToken 返回值中瞬时存在，
 * 日志 / 事件 / 错误消息一律不落明文；落库列显式点名，禁止 SELECT *（§3.5 MUST）。
 *
 * @module @agenthub/credential-vault/service
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  AgenthubError,
  createLogger,
  type CredentialExpiredPayload,
  type Logger,
  type Queryable,
} from '@agenthub/_shared'

/** AES-256 密钥字节数（secrets.md §2.1 MUST）。 */
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
/** P3 只落 key_version=1；KEK 惰性重加密登记为后续（方案书 §4.2）。 */
const CURRENT_KEY_VERSION = 1

/** 携带位置只允许小写请求头名（与 0020 的 CHECK 同口径）。 */
const CARRIER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** user_credentials 行最小读取面（显式列名；encrypted_payload 为密文字节）。 */
export interface VaultCredentialRow {
  encrypted_payload: Buffer
  key_version: number
  expires_at: Date | string | null
  carrier: string | null
}

export interface StoreCredentialInput {
  userId: string
  systemConnectionId: string
  /** 待加密明文（请求体内取得，加密后即弃，不驻留）。 */
  plaintext: string
  externalUserId?: string | null
  expiresAt?: Date | string | null
  /** 外部系统前端携带这份凭证所用的请求头名；省略时调用按连接认证方式决定。 */
  carrier?: string | null
}

/** 解密后的凭证与其携带位置（明文只允许注入外部请求）。 */
export interface ResolvedCredential {
  plaintext: string
  carrier: string | null
}

/** 员工在某条连接上的登录状态；只读到期时间，不读密文。 */
export type CredentialStatus = 'missing' | 'expired' | 'ready'

export interface StoredCredential {
  id: string
  keyVersion: number
  expiresAt: string | null
}

export interface CredentialVaultOptions {
  /** Base64 主密钥；缺失或解码 ≠ 32 字节 → 构造期抛错（secrets.md §4）。 */
  masterKey: string | undefined
  now?: () => Date
  /** credential.expired 事件出口（插件接 ctx.emit；测试注入收集器）。 */
  onCredentialExpired?: (payload: CredentialExpiredPayload) => void
  /** 日志注入点（测试收集断言；默认 stdout JSON 行）。 */
  logger?: Logger
}

function decodeMasterKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw === '') {
    throw new AgenthubError(
      'agenthub/credential-vault/MasterKeyMissing',
      'AGENTHUB_VAULT_MASTER_KEY 未设置；用 openssl rand -base64 32 生成并经环境变量注入（secrets.md §1.1）',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new AgenthubError(
      'agenthub/credential-vault/MasterKeyInvalid',
      `AGENTHUB_VAULT_MASTER_KEY Base64 解码后必须为 ${KEY_BYTES} 字节，实际 ${key.length} 字节；请重新生成`,
    )
  }
  return key
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export class CredentialVaultService {
  private readonly logger: Logger
  private readonly masterKey: Buffer
  private readonly now: () => Date
  private readonly onCredentialExpired?: ((payload: CredentialExpiredPayload) => void) | undefined

  constructor(
    private readonly db: Queryable,
    options: CredentialVaultOptions,
  ) {
    this.masterKey = decodeMasterKey(options.masterKey)
    this.now = options.now ?? (() => new Date())
    this.onCredentialExpired = options.onCredentialExpired
    this.logger = options.logger ?? createLogger('agenthub/credential-vault')
  }

  /** 加密并 UPSERT 落库（同 (user_id, system_connection_id) 覆盖旧凭证）；不回传任何密文相关数据。 */
  async storeCredential(input: StoreCredentialInput): Promise<StoredCredential> {
    const carrier = input.carrier ?? null
    if (carrier !== null && !CARRIER_RE.test(carrier)) {
      throw new AgenthubError(
        'agenthub/credential-vault/InvalidCarrier',
        '凭证携带位置必须是小写请求头名',
        { httpStatus: 422 },
      )
    }
    const payload = this.encrypt(input.plaintext)
    const expiresAt = input.expiresAt === undefined ? null : input.expiresAt
    const { rows } = await this.db.query<{ id: string; key_version: number; expires_at: Date | string | null }>(
      'INSERT INTO user_credentials'
      + ' (user_id, system_connection_id, external_user_id, encrypted_payload, key_version, expires_at, carrier)'
      + ' VALUES ($1, $2, $3, $4, $5, $6, $7)'
      + ' ON CONFLICT (user_id, system_connection_id) DO UPDATE SET'
      + ' external_user_id = EXCLUDED.external_user_id,'
      + ' encrypted_payload = EXCLUDED.encrypted_payload,'
      + ' key_version = EXCLUDED.key_version,'
      + ' expires_at = EXCLUDED.expires_at,'
      + ' carrier = EXCLUDED.carrier,'
      + ' updated_at = now()'
      + ' RETURNING id, key_version, expires_at',
      [
        input.userId,
        input.systemConnectionId,
        input.externalUserId ?? null,
        payload,
        CURRENT_KEY_VERSION,
        expiresAt,
        carrier,
      ],
    )
    const row = rows[0]
    if (!row) {
      throw new AgenthubError('agenthub/credential-vault/StoreFailed', '凭证写入未返回行')
    }
    this.logger.info(
      { event: 'vault.stored', projectId: null, userId: input.userId, traceId: null, sessionId: null },
      { systemConnectionId: input.systemConnectionId, keyVersion: row.key_version },
    )
    return { id: row.id, keyVersion: row.key_version, expiresAt: toIso(row.expires_at) }
  }

  /**
   * 解密取 token（仅 connector Tool 执行体内调用；返回值禁止进入日志/事件/审计）。
   * - 未绑定 → TokenMissing（404）：调用方发 externalSystemTokenRequired 引导绑定；
   * - 已过期 → 过期先于解密判定，emit credential.expired 后抛 TokenExpired（403）。
   */
  async resolveToken(userId: string, systemConnectionId: string): Promise<string> {
    return (await this.resolveCredential(userId, systemConnectionId)).plaintext
  }

  /** 同 resolveToken，另带回携带位置；过期与缺失的判定完全一致。 */
  async resolveCredential(userId: string, systemConnectionId: string): Promise<ResolvedCredential> {
    // ✅ MUST（§3.5）：显式列名查询，绝不 SELECT *。
    const { rows } = await this.db.query<VaultCredentialRow>(
      'SELECT encrypted_payload, key_version, expires_at, carrier FROM user_credentials'
      + ' WHERE user_id = $1 AND system_connection_id = $2',
      [userId, systemConnectionId],
    )
    const row = rows[0]
    if (!row) {
      throw new AgenthubError(
        'agenthub/credential-vault/TokenMissing',
        '该用户在此系统连接下尚未绑定凭证',
        { httpStatus: 404 },
      )
    }
    const expiresAt = row.expires_at === null ? null : new Date(row.expires_at)
    if (expiresAt !== null && expiresAt.getTime() <= this.now().getTime()) {
      const expiredAt = expiresAt.toISOString()
      this.logger.warn(
        { event: 'vault.expired', projectId: null, userId, traceId: null, sessionId: null },
        { systemConnectionId, expiredAt },
      )
      this.onCredentialExpired?.({ userId, systemConnectionId, expiredAt })
      throw new AgenthubError(
        'agenthub/credential-vault/TokenExpired',
        '凭证已过期，请重新授权或更新 token',
        { httpStatus: 403 },
      )
    }
    const plaintext = this.decrypt(row.encrypted_payload)
    this.logger.debug(
      { event: 'vault.resolved', projectId: null, userId, traceId: null, sessionId: null },
      { systemConnectionId, keyVersion: row.key_version },
    )
    return { plaintext, carrier: row.carrier }
  }

  /** 外部系统已判定这份凭证不再有效：立即记为过期，下一次调用会要求重新登录。 */
  async expireCredential(userId: string, systemConnectionId: string): Promise<void> {
    await this.db.query(
      'UPDATE user_credentials SET expires_at = $3, updated_at = now()'
      + ' WHERE user_id = $1 AND system_connection_id = $2',
      [userId, systemConnectionId, this.now()],
    )
    this.logger.info(
      { event: 'vault.invalidated', projectId: null, userId, traceId: null, sessionId: null },
      { systemConnectionId },
    )
  }

  /** 登录状态（不解密、不读密文列）。 */
  async credentialStatus(userId: string, systemConnectionId: string): Promise<CredentialStatus> {
    const { rows } = await this.db.query<{ expires_at: Date | string | null }>(
      'SELECT expires_at FROM user_credentials WHERE user_id = $1 AND system_connection_id = $2',
      [userId, systemConnectionId],
    )
    const row = rows[0]
    if (row === undefined) return 'missing'
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= this.now().getTime()) return 'expired'
    return 'ready'
  }

  /** 删除绑定（§3.5 无软删列，物理删行；密文随行消失，无明文残留面）。 */
  async deleteCredential(userId: string, systemConnectionId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      'DELETE FROM user_credentials WHERE user_id = $1 AND system_connection_id = $2 RETURNING id',
      [userId, systemConnectionId],
    )
    const deleted = rows.length > 0
    this.logger.info(
      { event: 'vault.deleted', projectId: null, userId, traceId: null, sessionId: null },
      { systemConnectionId, deleted },
    )
    return deleted
  }

  /** 密文 = iv(12B) || authTag(16B) || ciphertext。 */
  private encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  /** GCM 认证标签校验失败（篡改/密钥不匹配）→ DecryptFailed，原始 crypto 错误不外泄。 */
  private decrypt(payload: Buffer): string {
    // 下界为 iv + authTag：空明文密文恰为 IV_BYTES + AUTH_TAG_BYTES（ciphertext 长度 0），
    // 不得用 `+1` 把它误判为损坏（A-3）。
    if (payload.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new AgenthubError('agenthub/credential-vault/DecryptFailed', '凭证密文长度非法，可能已损坏')
    }
    const iv = payload.subarray(0, IV_BYTES)
    const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES)
    const ciphertext = payload.subarray(IV_BYTES + AUTH_TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv)
    decipher.setAuthTag(authTag)
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new AgenthubError(
        'agenthub/credential-vault/DecryptFailed',
        '凭证解密失败：密文被篡改或主密钥不匹配',
        { cause: error },
      )
    }
  }
}
