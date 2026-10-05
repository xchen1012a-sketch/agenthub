/**
 * 假 DB（按 SQL 形状回放；不引真 PG）。
 *
 * 覆盖本包用到的三块表：system_connections（CRUD）、user_credentials（vault 落库/读取）、
 * tools JOIN system_connections（connector Tool 载入）。
 *
 * @module tests/fakes
 */
import type { ConnectorToolRow, SystemConnectionRow } from '../src/index.ts'

export interface FakeCredentialRow {
  user_id: string
  system_connection_id: string
  encrypted_payload: Buffer
  key_version: number
  expires_at: Date | string | null
  carrier: string | null
}

export class FakeDb {
  readonly projects: { id: string; system_connection_id: string | null }[] = []
  readonly connections: SystemConnectionRow[] = []
  readonly credentials: FakeCredentialRow[] = []
  /** connector Tool 载入行（tools JOIN system_connections 投影）。 */
  connectorTools: ConnectorToolRow[] = []
  /** C-2：connection 所属 Project 成员（反代门禁假数据；平台管理员由 roles 决定，不进此表）。 */
  readonly projectMembers: { connection_id: string; user_id: string }[] = []
  /** C-5：Tool 启用态（未登记 id 默认 true，聚焦惰性校验分支）。 */
  readonly toolEnabled = new Map<string, boolean>()
  /** 已执行语句（断言注册过滤条件等 SQL 形状）。 */
  readonly statements: { text: string; values?: readonly unknown[] }[] = []
  private tick = 0

  private nowIso(): string {
    this.tick += 1
    return new Date(Date.UTC(2026, 9, 2, 8, 0, this.tick)).toISOString()
  }

  async query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(values === undefined ? { text: sql } : { text: sql, values })
    const params = values ?? []
    // C-5：惰性启用态读取。
    if (sql.startsWith('SELECT enabled FROM tools WHERE id = $1')) {
      return { rows: [{ enabled: this.toolEnabled.get(String(params[0])) ?? true }] }
    }
    // C-2：反代门禁（projects JOIN project_members JOIN users）。
    if (sql.includes('JOIN project_members')) {
      const member = this.projectMembers.find(
        item => item.connection_id === String(params[0]) && item.user_id === String(params[1]),
      )
      return { rows: member === undefined ? [] : [{ ok: 1 }] }
    }
    if (sql.startsWith('UPDATE projects SET system_connection_id')) {
      const connectionId = String(params[0])
      const projectId = String(params[1])
      const project = this.projects.find(item => item.id === projectId && item.system_connection_id === null)
      if (project === undefined) return { rows: [] }
      project.system_connection_id = connectionId
      const connection = this.connections.find(item => item.id === connectionId)
      if (connection !== undefined) connection.project_id = projectId
      return { rows: [{ id: project.id }] }
    }
    if (sql.startsWith('SELECT id, system_connection_id FROM projects')) {
      const project = this.projects.find(item => item.id === String(params[0]))
      return { rows: project === undefined ? [] : [{ ...project }] }
    }
    if (sql.startsWith('UPDATE tools SET enabled = false')) {
      return { rows: [] }
    }
    if (sql.startsWith('DELETE FROM user_credentials WHERE system_connection_id')) {
      const before = this.credentials.length
      for (let index = this.credentials.length - 1; index >= 0; index -= 1) {
        if (this.credentials[index]?.system_connection_id === String(params[0])) this.credentials.splice(index, 1)
      }
      return { rows: before === this.credentials.length ? [] : [{ id: 'cleared' }] }
    }
    // system_connections · INSERT
    if (sql.startsWith('INSERT INTO system_connections')) {
      const [id, name, baseUrl, frontendUrl, authMode, openapiUrl, openapiDoc, allowedHosts, createdBy] = params as [
        string, string, string, string, string, string | null, string | null, string[], string,
      ]
      const now = this.nowIso()
      const row: SystemConnectionRow = {
        id,
        name,
        base_url: baseUrl,
        frontend_url: frontendUrl,
        auth_mode: authMode,
        openapi_url: openapiUrl,
        openapi_doc: openapiDoc === null ? null : (JSON.parse(openapiDoc) as unknown),
        allowed_hosts: allowedHosts,
        project_id: null,
        created_by: createdBy,
        created_at: now,
        updated_at: now,
      }
      this.connections.push(row)
      return { rows: [{ ...row }] }
    }
    // system_connections · UPDATE
    if (sql.startsWith('UPDATE system_connections SET')) {
      const row = this.connections.find(item => item.id === String(params[0]))
      if (row === undefined) return { rows: [] }
      const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf(' WHERE'))
      const assignments = setClause.split(',').map(item => item.trim()).filter(item => item !== '' && !item.startsWith('updated_at'))
      assignments.forEach((assignment, offset) => {
        const value = params[offset + 1]
        if (assignment.startsWith('name ')) row.name = String(value)
        else if (assignment.startsWith('base_url ')) row.base_url = String(value)
        else if (assignment.startsWith('frontend_url ')) row.frontend_url = String(value)
        else if (assignment.startsWith('auth_mode ')) row.auth_mode = String(value)
        else if (assignment.startsWith('openapi_url ')) row.openapi_url = value as string | null
        else if (assignment.startsWith('openapi_doc ')) {
          const raw = value as string | null
          row.openapi_doc = raw === null ? null : (JSON.parse(raw) as unknown)
        } else if (assignment.startsWith('allowed_hosts ')) row.allowed_hosts = value as string[]
      })
      row.updated_at = this.nowIso()
      return { rows: [{ id: row.id, ...row }] }
    }
    // system_connections · DELETE
    if (sql.startsWith('DELETE FROM system_connections')) {
      const index = this.connections.findIndex(item => item.id === String(params[0]))
      if (index === -1) return { rows: [] }
      const [removed] = this.connections.splice(index, 1)
      return { rows: [{ id: removed?.id }] }
    }
    // system_connections · 列表
    if (sql.includes('FROM system_connections') && sql.includes('ORDER BY') && sql.includes('created_at DESC')) {
      return { rows: [...this.connections].reverse().map(row => ({ ...row })) }
    }
    // system_connections · 单行
    // 按 `FROM system_connections` + `WHERE id = $1` 两段匹配：服务层的探测查询
    // （校验白名单与文档地址的组合）列清单与 getConnection 不同，固定字符串前缀会漏匹配。
    if (sql.includes('FROM system_connections') && (sql.includes('WHERE id = $1') || sql.includes('WHERE c.id = $1'))) {
      const row = this.connections.find(item => item.id === String(params[0]))
      return { rows: row === undefined ? [] : [{ ...row }] }
    }
    // user_credentials · UPSERT（vault.storeCredential）
    if (sql.startsWith('INSERT INTO user_credentials')) {
      const [userId, connectionId, , payload, keyVersion, expiresAt, carrier] = params as [
        string, string, string | null, Buffer, number, Date | string | null, string | null,
      ]
      const existing = this.credentials.find(
        item => item.user_id === userId && item.system_connection_id === connectionId,
      )
      if (existing === undefined) {
        this.credentials.push({
          user_id: userId,
          system_connection_id: connectionId,
          encrypted_payload: payload,
          key_version: keyVersion,
          expires_at: expiresAt,
          carrier,
        })
      } else {
        existing.encrypted_payload = payload
        existing.key_version = keyVersion
        existing.expires_at = expiresAt
        existing.carrier = carrier
      }
      const stored = this.credentials.find(
        item => item.user_id === userId && item.system_connection_id === connectionId,
      )
      return { rows: [{ id: `cred-${String(this.credentials.length)}`, key_version: stored?.key_version ?? keyVersion, expires_at: stored?.expires_at ?? expiresAt }] }
    }
    // user_credentials · 标记失效（vault.expireCredential）
    if (sql.startsWith('UPDATE user_credentials SET expires_at')) {
      const row = this.credentials.find(
        item => item.user_id === String(params[0]) && item.system_connection_id === String(params[1]),
      )
      if (row !== undefined) row.expires_at = params[2] as Date
      return { rows: [] }
    }
    // user_credentials · 读取（vault.resolveCredential / credentialStatus）
    if (sql.startsWith('SELECT') && sql.includes('FROM user_credentials') && sql.includes('WHERE user_id = $1 AND system_connection_id = $2')) {
      const row = this.credentials.find(
        item => item.user_id === String(params[0]) && item.system_connection_id === String(params[1]),
      )
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
    // user_credentials · 删除（vault.deleteCredential）
    if (sql.startsWith('DELETE FROM user_credentials')) {
      const index = this.credentials.findIndex(
        item => item.user_id === String(params[0]) && item.system_connection_id === String(params[1]),
      )
      if (index === -1) return { rows: [] }
      this.credentials.splice(index, 1)
      return { rows: [{ id: `cred-${String(index)}` }] }
    }
    // tools JOIN system_connections（connector Tool 载入）
    // 模拟 WHERE enabled = true：未登记 id 默认启用（与 toolEnabled 语义一致）。
    if (sql.includes('FROM tools t JOIN system_connections c')) {
      const rows = this.connectorTools.filter(item => this.toolEnabled.get(item.id) ?? true)
      return { rows: rows.map(item => ({ ...item })) }
    }
    return { rows: [] }
  }
}
