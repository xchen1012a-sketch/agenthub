/**
 * 测试假实现（vault.spec 专用）。
 *
 * @module tests/fakes
 */
export interface FakeCredentialRow {
  id: string
  encrypted_payload: Buffer
  key_version: number
  expires_at: Date | null
  carrier: string | null
}

type UpsertValues = [string, string, string | null, Buffer, number, Date | string | null, string | null]

/** 假 DB：内存表模拟 user_credentials 的 UPSERT / SELECT / UPDATE / DELETE（不触真实 PostgreSQL）。 */
export class FakeVaultDb {
  readonly statements: { text: string; values?: readonly unknown[] }[] = []
  private readonly rows = new Map<string, FakeCredentialRow>()
  private nextId = 1

  private key(userId: string, systemConnectionId: string): string {
    return `${userId}|${systemConnectionId}`
  }

  /** 直读内存行（篡改密文用例用）。 */
  row(userId: string, systemConnectionId: string): FakeCredentialRow | undefined {
    return this.rows.get(this.key(userId, systemConnectionId))
  }

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push({ text, ...(values !== undefined ? { values } : {}) })
    if (text.includes('ON CONFLICT (user_id, system_connection_id)')) {
      const [userId, connectionId, , payload, keyVersion, expiresAt, carrier] =
        (values ?? []) as UpsertValues
      const row: FakeCredentialRow = {
        id: `cred-${this.nextId++}`,
        encrypted_payload: Buffer.from(payload),
        key_version: keyVersion,
        expires_at: expiresAt === null ? null : new Date(expiresAt),
        carrier,
      }
      this.rows.set(this.key(userId, connectionId), row)
      return { rows: [{ id: row.id, key_version: row.key_version, expires_at: row.expires_at }] }
    }
    if (text.startsWith('SELECT encrypted_payload')) {
      const [userId, connectionId] = (values ?? []) as [string, string]
      const row = this.rows.get(this.key(userId, connectionId))
      if (row === undefined) return { rows: [] }
      return {
        rows: [{
          encrypted_payload: row.encrypted_payload,
          key_version: row.key_version,
          expires_at: row.expires_at,
          carrier: row.carrier,
        }],
      }
    }
    if (text.startsWith('SELECT expires_at')) {
      const [userId, connectionId] = (values ?? []) as [string, string]
      const row = this.rows.get(this.key(userId, connectionId))
      return { rows: row === undefined ? [] : [{ expires_at: row.expires_at }] }
    }
    if (text.startsWith('UPDATE user_credentials SET expires_at')) {
      const [userId, connectionId, at] = (values ?? []) as [string, string, Date]
      const row = this.rows.get(this.key(userId, connectionId))
      if (row !== undefined) row.expires_at = at
      return { rows: [] }
    }
    if (text.startsWith('DELETE FROM user_credentials')) {
      const [userId, connectionId] = (values ?? []) as [string, string]
      const row = this.rows.get(this.key(userId, connectionId))
      if (row === undefined) return { rows: [] }
      this.rows.delete(this.key(userId, connectionId))
      return { rows: [{ id: row.id }] }
    }
    return { rows: [] }
  }
}
