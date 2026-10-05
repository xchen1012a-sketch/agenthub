/**
 * Tool 目录缓存（P2 方案书 T6 loader.ts）。
 *
 * 启动后懒加载：按 Project 查 `tools(enabled=true) ∩ project_tool_set(enabled=true)`
 * 计算 allow 列表；`project.created` / Tool Set 变更时 `refresh()` 失效缓存。
 * 风险级别来自 `tools.risk_level`（.ai-spec 20-security.md BND-2：是否审批由字段决定，不由模型决定）。
 *
 * @module @agenthub/project-tool-scope/loader
 */
import { createLogger, type Logger, type Queryable } from '@agenthub/_shared'
import { MANUAL_TOOL_NAMES } from './tools.ts'

/** 目录访问面（scope/hooks 依赖此接口，测试用假实现替代）。 */
export interface ToolCatalog {
  /** 某 Project 当前可用的 Tool 名（fail-closed：无配置 → 空列表）。 */
  allowedToolNames(projectId: string): Promise<string[]>
  /** 失效缓存（Project Tool Set 变更后重算）。 */
  refresh(projectId: string): Promise<void>
  /** Tool 风险级别；未知 Tool 返回 null。 */
  riskLevelOf(toolName: string): Promise<string | null>
  /** 全部业务 Tool 名（tools 表登记的与手动示例 Tool，不论启停），未绑定会话据此隐藏。 */
  businessToolNames(): Promise<string[]>
}

export class ToolCatalogService implements ToolCatalog {
  private readonly logger: Logger
  /** projectId → allow 名单（懒加载缓存）。 */
  private readonly allowed = new Map<string, string[]>()
  /** toolName → risk_level（懒加载缓存）。 */
  private readonly risks = new Map<string, string>()

  constructor(private readonly db: Queryable) {
    this.logger = createLogger('agenthub/project-tool-scope/catalog')
  }

  async allowedToolNames(projectId: string): Promise<string[]> {
    const cached = this.allowed.get(projectId)
    if (cached !== undefined) return cached
    const { rows } = await this.db.query<{ name: string }>(
      'SELECT t.name FROM project_tool_set pts JOIN tools t ON t.id = pts.tool_id'
      + ' WHERE pts.project_id = $1 AND pts.enabled = true AND t.enabled = true',
      [projectId],
    )
    const names = rows.map(row => row.name)
    this.allowed.set(projectId, names)
    return names
  }

  refresh(projectId: string): Promise<void> {
    this.allowed.delete(projectId)
    this.risks.clear()
    this.logger.debug({ event: 'tool-catalog.refreshed', projectId, userId: null, traceId: null, sessionId: null }, {})
    return Promise.resolve()
  }

  async riskLevelOf(toolName: string): Promise<string | null> {
    if (this.risks.size === 0) {
      const { rows } = await this.db.query<{ name: string; risk_level: string }>(
        'SELECT name, risk_level FROM tools WHERE enabled = true',
      )
      for (const row of rows) this.risks.set(row.name, row.risk_level)
    }
    return this.risks.get(toolName) ?? null
  }

  async businessToolNames(): Promise<string[]> {
    const { rows } = await this.db.query<{ name: string }>('SELECT name FROM tools')
    return [...new Set([...MANUAL_TOOL_NAMES, ...rows.map(row => row.name)])]
  }
}
