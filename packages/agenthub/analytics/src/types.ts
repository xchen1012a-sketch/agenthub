/**
 * 运营分析指标（P5 阶段书 §7.1-1）。
 *
 * 6 类指标：Tool 调用量与成功率、平均耗时、Badcase 分布、Project 活跃度、
 * 记忆确认率。窗口内当前值 + 前一等长窗口用于环比。
 *
 * @module @agenthub/analytics/types
 */

/** 允许的统计窗口（天）。 */
export type AnalyticsWindow = 7 | 14 | 30

/** 窗口解析结果：天数与用于前端的标签。 */
export interface WindowSpec {
  readonly days: AnalyticsWindow
  readonly label: string
}

/** 一条 Badcase 归因分布。 */
export interface CauseCount {
  readonly cause: string
  readonly count: number
}

/** 一个 Project 的活跃度。 */
export interface ProjectActivity {
  readonly projectId: string
  readonly projectName: string
  /** 窗口内该 Project 的 Tool 调用次数。 */
  readonly calls: number
  /** 窗口内有调用的去重会话数。 */
  readonly sessions: number
}

/** 6 类指标 + 环比（`delta` 为百分数整数；无前窗口数据时为 null）。 */
export interface AnalyticsSnapshot {
  /** ① Tool 调用量与成功率。 */
  readonly toolCalls: number
  readonly successRate: number
  /** ② 平均耗时（毫秒）；窗口内无带耗时的记录时为 null。 */
  readonly avgDurationMs: number | null
  /** ③ Badcase 分布（窗口内新建的 badcases）。 */
  readonly badcaseDistribution: readonly CauseCount[]
  readonly badcaseTotal: number
  /** ④ Project 活跃度（按调用量降序）。 */
  readonly projectActivity: readonly ProjectActivity[]
  /**
   * ⑤ 记忆确认率与基数。
   *
   * ⚠️ 语义边界：`rejectCandidate` 是**物理删行**，被拒绝的候选在库中已不存在，
   * 因此"提取后确认的比例"**无法从现有数据算出**。此处给的是**活行中已确认的占比**
   * ——即"当前生效记忆 / 全部未软删记忆"。它可与基数一起解读，但不是提取确认率。
   */
  readonly confirmationRate: number
  readonly confirmed: number
  readonly liveMemories: number
  /** 窗口内活跃用户数（有 Tool 调用的去重 user_id）。 */
  readonly activeUsers: number
  /** 窗口内去重会话数（有调用的 agent 会话）。 */
  readonly sessions: number
  /** 前一等长窗口的同名值（无数据 → 0），供调用方自行算环比。 */
  readonly previous: {
    readonly toolCalls: number
    readonly successRate: number
    readonly badcaseTotal: number
    readonly activeUsers: number
    readonly sessions: number
  }
  /** 审批数：窗口内与前一窗口（KPI `approvalRate` 的分子）。 */
  readonly approvals: number
  readonly previousApprovals: number
  /** 每日调用趋势：长度 = 窗口天数，索引 0 为最早一天。 */
  readonly toolTrend: readonly number[]
  /** 调用量最高的工具（窗口内，最多 5 条）。 */
  readonly topTools: readonly { readonly api: string; readonly count: number }[]
  /** ⑥ 环比（百分数整数；无前窗口数据 → null）。 */
  readonly delta: {
    readonly toolCalls: number | null
    readonly successRate: number | null
    readonly badcaseTotal: number | null
  }
}
