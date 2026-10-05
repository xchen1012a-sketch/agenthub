/**
 * 假 DB（按 SQL 形状回放；不引真 PG）。
 *
 * 覆盖本包用到的两块表：`tools`（草稿行 INSERT + name 唯一冲突）与
 * `system_connections`（openapi_url / openapi_doc 读取）。
 *
 * @module tests/fakes
 */
import type { Queryable } from '@agenthub/_shared'
import { OpenApiIngestService } from '../src/index.ts'

export interface FakeConnectionRow {
  id: string
  openapi_url: string | null
  openapi_doc: unknown
  /** 出站目标白名单（C-4）；未设置的用例按空数组处理，即默认全拒受限地址。 */
  allowed_hosts?: string[]
}

/** 已落库 tools 行的最小投影（断言参数用）。 */
export interface FakeToolRow {
  name: string
  description: string
  parameters: Record<string, unknown>
  source_ref: string | null
  system_connection_id: string | null
  created_by: string | null
  /** 阶段 C3-A：分级结论（未分级时为 'read'）。 */
  risk_level: string
}

export class FakeIngestDb {
  readonly connectionRows: FakeConnectionRow[] = []
  /** 已占用 name（预置项模拟既有 tools 行）。 */
  readonly toolNames = new Set<string>()
  readonly toolRows: FakeToolRow[] = []
  readonly statements: { text: string; values?: readonly unknown[] }[] = []
  private tick = 0

  async query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(values === undefined ? { text: sql } : { text: sql, values })
    const params = values ?? []
    if (sql.startsWith('INSERT INTO tools')) {
      // 列顺序：name, description, parameters, source_ref, system_connection_id, created_by, risk_level
      const [name, description, parameters, sourceRef, connectionId, createdBy, riskLevel] = params as [
        string, string, string, string | null, string | null, string | null, string,
      ]
      if (this.toolNames.has(name)) return { rows: [] }
      this.toolNames.add(name)
      this.tick += 1
      this.toolRows.push({
        name,
        description,
        parameters: JSON.parse(parameters) as Record<string, unknown>,
        source_ref: sourceRef,
        system_connection_id: connectionId,
        created_by: createdBy,
        risk_level: riskLevel,
      })
      return { rows: [{ id: `tool-${String(this.tick)}` }] }
    }
    if (sql.includes('FROM system_connections WHERE id = $1')) {
      const row = this.connectionRows.find(item => item.id === String(params[0]))
      return {
        rows: row === undefined
          ? []
          : [{ openapi_url: row.openapi_url, openapi_doc: row.openapi_doc, allowed_hosts: row.allowed_hosts ?? [] }],
      }
    }
    return { rows: [] }
  }
}

/** 便捷：注入 FakeIngestDb 的服务实例。 */
export function withDb(
  db: FakeIngestDb,
  options: ConstructorParameters<typeof OpenApiIngestService>[1] = {},
): OpenApiIngestService {
  return new OpenApiIngestService(db as unknown as Queryable, options)
}
