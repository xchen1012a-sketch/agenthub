/**
 * 审批工具目录：按 tool 名查 tools 表的 id / risk_level / requires_approval。
 *
 * 与 project-tool-scope 的 ToolCatalog 分工：本包只关心审批策略字段，
 * 不做 allow 列表与缓存失效（那是可见性隔离的职责）。
 *
 * @module @agenthub/approval/catalog
 */
import type { Queryable } from '@agenthub/_shared'
import type { ToolPolicyFacts } from './policy.ts'

/** tools 表审批策略行。 */
export interface ApprovalToolRecord extends ToolPolicyFacts {
  readonly id: string
}

/** 目录访问面（测试用假实现替代）。 */
export interface ApprovalToolCatalog {
  /** 按 Tool 名查策略字段；未知 Tool 返回 null（调用方放行——可见性由 restrict 隔离）。 */
  toolFacts(toolName: string): Promise<ApprovalToolRecord | null>
}

export class PgApprovalToolCatalog implements ApprovalToolCatalog {
  constructor(private readonly db: Queryable) {}

  async toolFacts(toolName: string): Promise<ApprovalToolRecord | null> {
    const { rows } = await this.db.query<{
      id: string
      risk_level: string
      requires_approval: boolean
    }>(
      'SELECT id, risk_level, requires_approval FROM tools WHERE name = $1 LIMIT 1',
      [toolName],
    )
    const row = rows[0]
    if (row === undefined) return null
    return {
      id: row.id,
      riskLevel: row.risk_level,
      requiresApproval: row.requires_approval,
    }
  }
}
