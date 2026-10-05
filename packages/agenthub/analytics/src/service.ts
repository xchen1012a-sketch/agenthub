/**
 * 运营分析聚合（P5 阶段书 §7.1-1）。
 *
 * 只读聚合：不写任何表、不改变任何状态（只读面）。所有查询显式列名
 * （`.ai-spec/30-data.md` DATA-5），窗口天数一律走绑定参数。
 *
 * @module @agenthub/analytics/service
 */
import type { Queryable } from '@agenthub/_shared'
import type {
  AnalyticsSnapshot,
  AnalyticsWindow,
  CauseCount,
  ProjectActivity,
  WindowSpec,
} from './types.ts'

/** 合法窗口（天）。 */
const WINDOWS: readonly AnalyticsWindow[] = [7, 14, 30]

/** 未给或非法窗口时使用的默认值。 */
const DEFAULT_WINDOW: AnalyticsWindow = 14

/**
 * 解析窗口参数（`?window=14d`）。
 * @param raw - 原始查询串；`null` / 非法值 / 不支持的窗口都回落默认值。
 * @returns 天数与前端标签。
 */
export function parseWindow(raw: string | null): WindowSpec {
  const parsed = /^(\d+)d$/.exec(raw ?? '')?.[1]
  const days = parsed === undefined ? Number.NaN : Number.parseInt(parsed, 10)
  const accepted = (WINDOWS as readonly number[]).includes(days)
    ? (days as AnalyticsWindow)
    : DEFAULT_WINDOW
  return { days: accepted, label: `${String(accepted)}d` }
}

/** 环比：当前值相对前窗口的百分数整数；前窗口为 0 → null（无基数不算比例）。 */
function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

/** 百分比整数；分母为 0 → 0。 */
function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 100)
}

/** 从行里取字段（兼容 pg 返回的类型化行与假 DB 的通用行）。 */
type AnyRow = Readonly<Record<string, unknown>>

/** 取行里第一个值并转数字（假 DB 与 pg 的数字列可能是 string）。 */
function num(row: AnyRow | undefined, key: string): number {
  const value = row?.[key]
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 数字或 null（保留"确实没有"与"算出 0"的区别）。 */
function numOrNull(row: AnyRow | undefined, key: string): number | null {
  const value = row?.[key]
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 只读运营指标聚合。 */
export class AnalyticsService {
  /**
   * @param db - 共享数据库句柄（只读使用）。
   */
  constructor(private readonly db: Queryable) {}

  /**
   * 聚合一个窗口的 6 类指标。
   * @param window - 已解析的窗口（{@link parseWindow}），或原始查询串（如 `'14d'`）。
   * @returns 指标快照（含环比）。
   */
  async aggregate(window: WindowSpec | string | null): Promise<AnalyticsSnapshot> {
    const spec = typeof window === 'object' && window !== null ? window : parseWindow(window)
    const days = spec.days
    const [totals, distinct, deltas, distribution, badcases, approvals, projects, trend, top, memories] =
      await Promise.all([
        this.totals(days),
        this.distinctCounts(days),
        this.deltas(days),
        this.badcaseDistribution(days),
        this.badcaseTotals(days),
        this.approvalTotals(days),
        this.projectActivity(days),
        this.toolTrend(days),
        this.topTools(days),
        this.memoryRatio(),
      ])

    const toolCalls = num(totals, 'tool_calls')
    const okCalls = num(totals, 'ok_calls')
    const avgDuration = numOrNull(totals, 'avg_duration_ms')
    const prevCalls = num(deltas, 'prev_tool_calls')
    const prevOk = num(deltas, 'prev_ok_calls')

    return {
      toolCalls,
      successRate: percent(okCalls, toolCalls),
      avgDurationMs: avgDuration === null ? null : Math.round(avgDuration),
      badcaseDistribution: distribution,
      badcaseTotal: badcases.current,
      projectActivity: projects,
      confirmationRate: percent(memories.confirmed, memories.live),
      confirmed: memories.confirmed,
      liveMemories: memories.live,
      activeUsers: num(distinct, 'cur_dau'),
      sessions: num(distinct, 'cur_sessions'),
      previous: {
        toolCalls: prevCalls,
        successRate: percent(prevOk, prevCalls),
        badcaseTotal: badcases.previous,
        activeUsers: num(distinct, 'prev_dau'),
        sessions: num(distinct, 'prev_sessions'),
      },
      approvals: num(approvals, 'cur_count'),
      previousApprovals: num(approvals, 'prev_count'),
      toolTrend: trend,
      topTools: top,
      delta: {
        toolCalls: deltaPercent(num(deltas, 'cur_tool_calls'), prevCalls),
        successRate: this.successRateDelta(deltas ?? {}),
        badcaseTotal: deltaPercent(badcases.current, badcases.previous),
      },
    }
  }

  /** 成功率环比：两个窗口各自的百分比之差（百分点）。 */
  private successRateDelta(row: Record<string, unknown>): number | null {
    const prevTotal = num(row, 'prev_tool_calls')
    if (prevTotal === 0) return null
    return percent(num(row, 'cur_ok_calls'), num(row, 'cur_tool_calls'))
      - percent(num(row, 'prev_ok_calls'), prevTotal)
  }

  /** ① 窗口内调用量 / 成功数 / 平均耗时。 */
  private async totals(days: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT'
      + ' COUNT(*)::int AS tool_calls,'
      + " COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_calls,"
      + " AVG((result_meta->>'durationMs')::numeric) AS avg_duration_ms"
      + ' FROM audit_records WHERE created_at >= now() - ($1::int * INTERVAL \'1 day\')',
      [days],
    )
    return rows[0]
  }

  /** 窗口与前一窗口的去重会话数与活跃用户数（DAU / 会话 KPI 用）。 */
  private async distinctCounts(days: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT'
      + " COUNT(DISTINCT session_id) FILTER (WHERE created_at >= now() - ($1::int * INTERVAL '1 day')"
      + " AND session_id IS NOT NULL AND session_id <> '')::int AS cur_sessions,"
      + " COUNT(DISTINCT session_id) FILTER (WHERE created_at < now() - ($1::int * INTERVAL '1 day')"
      + " AND session_id IS NOT NULL AND session_id <> '')::int AS prev_sessions,"
      + " COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - ($1::int * INTERVAL '1 day')"
      + ' AND user_id IS NOT NULL)::int AS cur_dau,'
      + " COUNT(DISTINCT user_id) FILTER (WHERE created_at < now() - ($1::int * INTERVAL '1 day')"
      + ' AND user_id IS NOT NULL)::int AS prev_dau'
      + " FROM audit_records WHERE created_at >= now() - ($1::int * INTERVAL '2 day')",
      [days],
    )
    return rows[0]
  }

  /** 审批数：窗口内与前窗口（`approvalRate` 的分子）。 */
  private async approvalTotals(days: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT'
      + " COUNT(*) FILTER (WHERE created_at >= now() - ($1::int * INTERVAL '1 day'))::int AS cur_count,"
      + " COUNT(*) FILTER (WHERE created_at < now() - ($1::int * INTERVAL '1 day'))::int AS prev_count"
      + " FROM approvals WHERE created_at >= now() - ($1::int * INTERVAL '2 day')",
      [days],
    )
    return rows[0]
  }

  /** 每日调用趋势：索引 0 为最早一天，长度 = 窗口天数。 */
  private async toolTrend(days: number): Promise<number[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT (now()::date - created_at::date) AS days_ago, COUNT(*)::int AS call_count'
      + " FROM audit_records WHERE created_at >= now() - ($1::int * INTERVAL '1 day') GROUP BY 1",
      [days],
    )
    const trend = new Array<number>(days).fill(0)
    for (const row of rows) {
      const index = days - 1 - num(row, 'days_ago')
      if (index >= 0 && index < days) trend[index] = num(row, 'call_count')
    }
    return trend
  }

  /** 窗口内调用量最高的工具（最多 5 条）。 */
  private async topTools(days: number): Promise<{ api: string; count: number }[]> {
    const { rows } = await this.db.query<{ tool_name: string; call_total: number }>(
      'SELECT tool_name, COUNT(*)::int AS call_total FROM audit_records'
      + " WHERE created_at >= now() - ($1::int * INTERVAL '1 day') GROUP BY tool_name"
      + ' ORDER BY call_total DESC LIMIT 5',
      [days],
    )
    return rows.map(row => ({ api: row.tool_name, count: row.call_total }))
  }

  /** ⑥ 环比用：当前窗口与前一等长窗口的调用量 / 成功数。 */
  private async deltas(days: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT'
      + " COUNT(*) FILTER (WHERE created_at >= now() - ($1::int * INTERVAL '1 day'))::int AS cur_tool_calls,"
      + " COUNT(*) FILTER (WHERE status = 'ok' AND created_at >= now() - ($1::int * INTERVAL '1 day'))::int AS cur_ok_calls,"
      + " COUNT(*) FILTER (WHERE created_at < now() - ($1::int * INTERVAL '1 day'))::int AS prev_tool_calls,"
      + " COUNT(*) FILTER (WHERE status = 'ok' AND created_at < now() - ($1::int * INTERVAL '1 day'))::int AS prev_ok_calls"
      + " FROM audit_records WHERE created_at >= now() - ($1::int * INTERVAL '2 day')",
      [days],
    )
    return rows[0]
  }

  /** ③ 窗口内新建 badcases 的归因分布（按数量降序）。 */
  private async badcaseDistribution(days: number): Promise<CauseCount[]> {
    const { rows } = await this.db.query<{ cause: string; cause_count: number }>(
      'SELECT category AS cause, COUNT(*)::int AS cause_count'
      + " FROM badcases WHERE created_at >= now() - ($1::int * INTERVAL '1 day')"
      + ' GROUP BY category ORDER BY cause_count DESC, cause ASC',
      [days],
    )
    return rows.map(row => ({ cause: row.cause, count: num(row, 'cause_count') }))
  }

  /** ③ 窗口内 badcase 总数 + 前窗口总数（一次查询返回两个值，供环比使用）。 */
  private async badcaseTotals(days: number): Promise<{ current: number; previous: number }> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT'
      + " COUNT(*) FILTER (WHERE created_at >= now() - ($1::int * INTERVAL '1 day'))::int AS cur_total,"
      + " COUNT(*) FILTER (WHERE created_at < now() - ($1::int * INTERVAL '1 day'))::int AS prev_total"
      + " FROM badcases WHERE created_at >= now() - ($1::int * INTERVAL '2 day')",
      [days],
    )
    return { current: num(rows[0], 'cur_total'), previous: num(rows[0], 'prev_total') }
  }

  /** ④ 窗口内每个 Project 的调用量与去重会话数（按调用量降序）。 */
  private async projectActivity(days: number): Promise<ProjectActivity[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT a.project_id AS project_id, p.name AS project_name,'
      + ' COUNT(*)::int AS call_count,'
      + " COUNT(DISTINCT a.session_id) FILTER (WHERE a.session_id IS NOT NULL AND a.session_id <> '')::int AS session_count"
      + ' FROM audit_records a LEFT JOIN projects p ON p.id = a.project_id'
      + " WHERE a.created_at >= now() - ($1::int * INTERVAL '1 day') AND a.project_id IS NOT NULL"
      + ' GROUP BY a.project_id, p.name ORDER BY call_count DESC, project_name ASC',
      [days],
    )
    return rows.map(row => ({
      projectId: String(row.project_id),
      // 显式判类型：LEFT JOIN 可能无匹配（NULL），也避免对非字符串做隐式字符串化。
      projectName: typeof row.project_name === 'string' ? row.project_name : '',
      calls: num(row, 'call_count'),
      sessions: num(row, 'session_count'),
    }))
  }

  /**
   * ⑤ 记忆确认率基数：活行中"已确认（非候选）"的数量与全部未软删行数。
   *
   * 注意：被拒绝的候选是**物理删行**，故"提取后确认比例"无法计算；
   * 本方法给的是"当前生效记忆 / 全部未软删记忆"。
   */
  private async memoryRatio(): Promise<{ confirmed: number; live: number }> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT'
      + " COUNT(*) FILTER (WHERE (metadata->>'status') IS DISTINCT FROM 'candidate')::int AS confirmed,"
      + ' COUNT(*)::int AS live'
      + " FROM project_memories WHERE (metadata->>'deleted') IS DISTINCT FROM 'true'",
    )
    const row = rows[0]
    return { confirmed: num(row, 'confirmed'), live: num(row, 'live') }
  }
}
