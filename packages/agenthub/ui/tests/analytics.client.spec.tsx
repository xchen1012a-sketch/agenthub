// @vitest-environment jsdom
/**
 * AnalyticsView 空态渲染（D-4）：空库 / 全 0 趋势与单点趋势不得产出 `NaN`
 * （`Math.max(...[])` 与 `data.length - 1` 的除零兜底）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { AnalyticsRecord } from '../src/client/api.ts'
import { mockApi } from '../src/client/mock/data.ts'
import { zh, type Translate } from '../src/client/locales.ts'
import { AnalyticsView } from '../src/client/views/AnalyticsView.tsx'

const t: Translate = key => zh[key]

afterEach(cleanup)

/** An all-zero analytics snapshot with empty trends (the empty-library shape). */
function emptyAnalytics(overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    kpi: { dau: 0, sessions: 0, toolCalls: 0, successRate: 0, badcaseRate: 0, approvalRate: 0 },
    deltas: { dau: null, sessions: null, toolCalls: null, successRate: null, badcaseRate: null, approvalRate: null },
    toolTrend: [],
    failCauses: [],
    topTools: [],
    ...overrides,
  }
}

describe('AnalyticsView 空态趋势图', () => {
  it('空趋势 + 全 0 KPI → 渲染不产出 NaN', async () => {
    const api = { ...mockApi, getAnalytics: async () => emptyAnalytics() }
    const { container } = render(<AnalyticsView t={t} api={api} />)
    await waitFor(() => { expect(container.querySelector('svg')).not.toBeNull() })
    expect(container.innerHTML).not.toContain('NaN')
  })

  it('单点趋势（length === 1）→ 不除零、不产出 NaN', async () => {
    const api = { ...mockApi, getAnalytics: async () => emptyAnalytics({ toolTrend: [42] }) }
    const { container } = render(<AnalyticsView t={t} api={api} />)
    await waitFor(() => { expect(container.querySelector('svg')).not.toBeNull() })
    expect(container.innerHTML).not.toContain('NaN')
  })
})
