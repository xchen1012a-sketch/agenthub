/**
 * 运营分析聚合（P5 阶段书 §7.1-1）。
 *
 * 用可注入的假 DB 固定返回面，断言 6 类指标与环比**从行到结果**的换算是否正确
 * （SQL 本身的正确性由 `aggregate.integration.spec.ts` 在真库上覆盖）。
 *
 * @module tests/aggregate.spec
 */
import { describe, expect, it } from 'vitest'
import type { Queryable } from '@agenthub/_shared'
import { AnalyticsService, parseWindow } from '../src/index.ts'

interface Canned {
  readonly text: string
  readonly rows: readonly Record<string, unknown>[]
}

/**
 * 按 SQL 特征回放固定行，并记录每条语句。
 * @param canneds - 匹配规则与返回行。
 * @returns 假 DB 与语句记录。
 */
function fakeDb(canneds: readonly Canned[]): { db: Queryable; seen: string[] } {
  const seen: string[] = []
  const db = {
    async query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
      seen.push(text)
      const hit = canneds.find(item => text.includes(item.text))
      return { rows: hit === undefined ? [] : [...hit.rows] }
    },
  } as unknown as Queryable
  return { db, seen }
}

/** 一组覆盖全部指标的固定返回面。 */
function happyCanneds(): Canned[] {
  // 匹配键必须是该查询里**唯一**的片段，且**具体键排在泛化键之前**：
  // 趋势查询同样含 `COUNT(*)::int AS call_count`，若把 'AS call_count' 排在前面，
  // 趋势会命中项目活跃度的假数据（早先版本即因此失败）。
  return [
    { text: 'AS days_ago', rows: [{ days_ago: 0, call_count: 7 }, { days_ago: 3, call_count: 2 }] },
    { text: 'AS call_total', rows: [{ tool_name: 'query_customer', call_total: 42 }] },
    {
      text: 'AVG((result_meta',
      rows: [{ tool_calls: 100, ok_calls: 90, avg_duration_ms: 123.45 }],
    },
    { text: 'AS cur_tool_calls', rows: [{ cur_tool_calls: 100, cur_ok_calls: 90, prev_tool_calls: 50, prev_ok_calls: 40 }] },
    { text: 'AS cause_count', rows: [{ cause: 'wrong_tool', cause_count: 3 }, { cause: 'timeout', cause_count: 1 }] },
    { text: 'FROM badcases', rows: [{ cur_total: 4, prev_total: 2 }] },
    { text: 'AS call_count', rows: [{ project_id: 'p-1', project_name: '销售', call_count: 60, session_count: 5 }] },
    { text: 'AS confirmed', rows: [{ confirmed: 7, live: 10 }] },
    { text: 'AS cur_dau', rows: [{ cur_dau: 3, prev_dau: 2, cur_sessions: 8, prev_sessions: 6 }] },
    { text: 'FROM approvals', rows: [{ cur_count: 5, prev_count: 4 }] },
  ]
}

describe('parseWindow', () => {
  it('未给或非法值 → 默认 14 天', () => {
    expect(parseWindow(null).days).toBe(14)
    expect(parseWindow('abc').days).toBe(14)
    expect(parseWindow('99d').days).toBe(14)
  })

  it('接受 7 / 14 / 30', () => {
    expect(parseWindow('7d').days).toBe(7)
    expect(parseWindow('14d').days).toBe(14)
    expect(parseWindow('30d').days).toBe(30)
  })
})

describe('AnalyticsService.aggregate · 6 类指标', () => {
  it('① Tool 调用量与成功率按窗口统计', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.toolCalls).toBe(100)
    expect(snapshot.successRate).toBe(90)
  })

  it('② 平均耗时取窗口内均值并四舍五入为整数毫秒', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.avgDurationMs).toBe(123)
  })

  it('② 无带耗时的记录 → 平均耗时为 null（不伪造成 0）', async () => {
    const { db } = fakeDb([
      { text: 'AS tool_calls', rows: [{ tool_calls: 5, ok_calls: 5, avg_duration_ms: null, sessions: 1, active_users: 1 }] },
    ])
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.avgDurationMs).toBeNull()
  })

  it('③ Badcase 分布按归因降序，并给出总数', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.badcaseTotal).toBe(4)
    expect(snapshot.badcaseDistribution).toEqual([
      { cause: 'wrong_tool', count: 3 },
      { cause: 'timeout', count: 1 },
    ])
  })

  it('④ Project 活跃度含项目名、调用量与去重会话数', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.projectActivity).toEqual([
      { projectId: 'p-1', projectName: '销售', calls: 60, sessions: 5 },
    ])
  })

  it('⑤ 确认率 = 已确认 / 全部未软删记忆，并给出基数', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.confirmed).toBe(7)
    expect(snapshot.liveMemories).toBe(10)
    expect(snapshot.confirmationRate).toBe(70)
  })

  it('⑤ 无记忆时确认率为 0（不是 null，也不是 100）', async () => {
    const { db } = fakeDb([{ text: 'AS confirmed', rows: [{ confirmed: 0, live: 0 }] }])
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.confirmationRate).toBe(0)
    expect(snapshot.liveMemories).toBe(0)
  })

  it('⑥ 环比给出百分数：100 vs 50 → +100%', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.delta.toolCalls).toBe(100)
    // 成功率 90% vs 80% → +10
    expect(snapshot.delta.successRate).toBe(10)
    // badcase 4 vs 2 → +100%
    expect(snapshot.delta.badcaseTotal).toBe(100)
  })

  it('⑥ 前窗口无数据 → 环比为 null（不伪造成 0 或 100）', async () => {
    const { db } = fakeDb([
      { text: 'AS cur_tool_calls', rows: [{ cur_tool_calls: 10, cur_ok_calls: 9, prev_tool_calls: 0, prev_ok_calls: 0 }] },
      { text: 'AS cur_total', rows: [{ cur_total: 1, prev_total: 0 }] },
    ])
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.delta.toolCalls).toBeNull()
    expect(snapshot.delta.badcaseTotal).toBeNull()
  })
})

describe('AnalyticsService.aggregate · 供 KPI 契约复用的量', () => {
  it('给出 DAU / 会话 / 审批的前窗口值（供调用方算环比）', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.activeUsers).toBe(3)
    expect(snapshot.sessions).toBe(8)
    expect(snapshot.approvals).toBe(5)
    expect(snapshot.previous).toEqual({
      toolCalls: 50,
      successRate: 80,
      badcaseTotal: 2,
      activeUsers: 2,
      sessions: 6,
    })
    expect(snapshot.previousApprovals).toBe(4)
  })

  it('趋势数组长度 = 窗口天数，索引 0 为最早一天', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.toolTrend).toHaveLength(14)
    // days_ago=0（今天）落在最后一位；days_ago=3 落在倒数第 4 位
    expect(snapshot.toolTrend[13]).toBe(7)
    expect(snapshot.toolTrend[10]).toBe(2)
    expect(snapshot.toolTrend[0]).toBe(0)
  })

  it('Top 工具按调用量返回 api 与次数', async () => {
    const { db } = fakeDb(happyCanneds())
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(snapshot.topTools).toEqual([{ api: 'query_customer', count: 42 }])
  })

  it('无数据时趋势全 0、Top 工具为空（不伪造成有数据）', async () => {
    const { db } = fakeDb([])
    const snapshot = await new AnalyticsService(db).aggregate(parseWindow('7d'))

    expect(snapshot.toolTrend).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(snapshot.topTools).toEqual([])
    expect(snapshot.avgDurationMs).toBeNull()
  })
})

describe('AnalyticsService.aggregate · 查询面约束', () => {
  it('所有查询都用显式列名（DATA-5：不出现 SELECT *）', async () => {
    const { db, seen } = fakeDb(happyCanneds())
    await new AnalyticsService(db).aggregate(parseWindow('14d'))

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some(text => /SELECT\s+\*/i.test(text))).toBe(false)
  })

  it('窗口天数作为绑定参数传入（受窗口影响的查询都传数字）', async () => {
    const seen: { text: string; values?: readonly unknown[] }[] = []
    const db = {
      async query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
        seen.push({ text, ...(values !== undefined ? { values } : {}) })
        return { rows: [] }
      },
    } as unknown as Queryable

    await new AnalyticsService(db).aggregate(parseWindow('30d'))

    // 记忆确认率是全局指标、与窗口无关，故不传天数；其余受窗口影响的查询必须传。
    const windowed = seen.filter(item => !item.text.includes('FROM project_memories'))
    expect(windowed.length).toBeGreaterThan(0)
    expect(windowed.every(item => item.values?.[0] === 30)).toBe(true)
    expect(windowed.every(item => typeof item.values?.[0] === 'number')).toBe(true)
  })
})
