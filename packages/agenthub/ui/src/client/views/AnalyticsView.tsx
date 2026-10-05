/**
 * AI 运营 (Analytics): overview tab with the KPI row, the 14-day tool-call
 * line chart, failure-cause and top-tool rankings, plus a Badcase tab reusing
 * the badcase table — composed from the admin kit per the prototype. Data
 * arrives through the module seam (future: GET /agenthub/api/analytics).
 */

import { useEffect, useState, type ReactNode } from 'react'
import { IconDataOutlineRegular, IconSlidersTwoOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminPage, Card, KpiRow } from '../ui/kit.tsx'
import css from '../ui/admin.module.css'
import type { AnalyticsRecord } from '../api.ts'
import type { Translate } from '../locales.ts'
import { BadcaseTable } from './ModuleViews.tsx'
import type { ModuleViewProps } from './ToolsView.tsx'

type AnalyticsTab = 'dash' | 'badcase'

const CHART_W = 640
const CHART_H = 160
const CHART_PAD = 8

/** One KPI tile: key into locale + raw value + tone rule. */
const KPI_DEFS = [
  { key: 'dau', pick: (k: AnalyticsRecord['kpi']) => String(k.dau) },
  { key: 'sessions', pick: (k: AnalyticsRecord['kpi']) => String(k.sessions) },
  { key: 'toolCalls', pick: (k: AnalyticsRecord['kpi']) => String(k.toolCalls) },
  { key: 'successRate', pick: (k: AnalyticsRecord['kpi']) => `${k.successRate}%` },
  { key: 'badcaseRate', pick: (k: AnalyticsRecord['kpi']) => `${k.badcaseRate}%` },
  { key: 'approvalRate', pick: (k: AnalyticsRecord['kpi']) => `${k.approvalRate}%` },
] as const

/**
 * Derive a KPI delta's tone: a falling badcase rate is an improvement.
 * @param key - the KPI key.
 * @param delta - the signed percent change (null = flat).
 * @returns the tone.
 */
function deltaTone(key: string, delta: number | null): 'up' | 'down' | 'flat' {
  if (delta === null || delta === 0) return 'flat'
  const rising = delta > 0
  return key === 'badcaseRate' ? (rising ? 'down' : 'up') : (rising ? 'up' : 'down')
}

/**
 * Render one KPI delta (U4: copy lives in the locale, not the API).
 * @param t - the locale binder.
 * @param delta - the signed percent change (null = flat).
 * @returns the display string.
 */
function formatDelta(t: Translate, delta: number | null): string {
  return delta === null ? t('analytics.delta.flat') : `${delta > 0 ? '+' : ''}${delta}%`
}

/**
 * Render the 14-day tool-call line chart (area + line + dots) as inline SVG
 * with a hover tip per point (the prototype's bindChartTips).
 * @param props.data - daily totals, oldest first.
 * @returns the chart element.
 */
function ToolTrendChart({ data }: { data: readonly number[] }): ReactNode {
  const [hover, setHover] = useState<number | undefined>(undefined)
  // Empty/all-zero trends and single points must not divide by zero (D-4).
  const max = Math.max(...data, 1) * 1.15
  const span = Math.max(data.length - 1, 1)
  const points = data.map((value, index) => [
    CHART_PAD + index * (CHART_W - CHART_PAD * 2) / span,
    CHART_H - CHART_PAD - value / max * (CHART_H - CHART_PAD * 2),
  ] as const)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const first = points[0]
  const area = first === undefined || last === undefined
    ? ''
    : `${path} L${last[0].toFixed(1)} ${CHART_H - CHART_PAD} L${first[0].toFixed(1)} ${CHART_H - CHART_PAD} Z`
  const hoverPoint = hover === undefined ? undefined : points[hover]
  const hoverValue = hover === undefined ? undefined : data[hover]
  return (
    <div className={css.chartWrap} onMouseLeave={() => { setHover(undefined) }}>
      <svg width="100%" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" style={{ display: 'block' }} role="img">
        <defs>
          <linearGradient id="agenthub-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4176E6" stopOpacity=".14" />
            <stop offset="1" stopColor="#4176E6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#agenthub-trend-fill)" />
        <path d={path} fill="none" stroke="#4176E6" strokeWidth="2" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={i}>
            {/* enlarged invisible hit target so the tip is easy to trigger */}
            <circle cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="10" fill="transparent" onMouseEnter={() => { setHover(i) }} />
            <circle
              cx={p[0].toFixed(1)} cy={p[1].toFixed(1)}
              r={hover === i ? 3.5 : 2.5}
              fill="#fff" stroke="#4176E6" strokeWidth="1.6" pointerEvents="none"
            />
          </g>
        ))}
      </svg>
      {hoverPoint !== undefined && hoverValue !== undefined && (
        <div
          className={css.chartTip}
          style={{
            left: `${hoverPoint[0] / CHART_W * 100}%`,
            top: `${hoverPoint[1] / CHART_H * 100}%`,
          }}
        >
          {hoverValue}
        </div>
      )}
    </div>
  )
}

/**
 * Render one horizontal ranking list (prototype .rank-item rows).
 * @param props.rows - name/count rows in ranked order.
 * @param props.label - label renderer (localized causes, mono tool api names).
 * @param props.unit - localized unit suffix.
 * @returns the ranking element.
 */
function RankList<N extends string>({ rows, label, unit }: {
  rows: readonly { readonly name: N; readonly count: number }[]
  label: (name: N) => ReactNode
  unit: string
}): ReactNode {
  const max = Math.max(...rows.map(row => row.count), 1)
  return (
    <div>
      {rows.map((row, index) => (
        <div key={row.name} className={css.rankItem}>
          <span className={css.rankNo}>{index + 1}</span>
          <span className={css.rankName}>{label(row.name)}</span>
          <span className={css.rankBar}>
            <span className={css.rankBarFill}><i style={{ width: `${Math.round(row.count / max * 100)}%` }} /></span>
          </span>
          <span className={css.rankVal}>{row.count}{unit}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Render the Analytics page.
 * @param props - the locale binder and the module data seam.
 * @returns the page element.
 */
export function AnalyticsView({ t, api }: ModuleViewProps): ReactNode {
  const [tab, setTab] = useState<AnalyticsTab>('dash')
  const [data, setData] = useState<AnalyticsRecord | undefined>(undefined)
  useEffect(() => {
    let live = true
    void api.getAnalytics().then((next) => {
      if (live) setData(next)
    })
    return () => { live = false }
  }, [api])

  return (
    <AdminPage
      title={t('panel.analytics')}
      desc={t('analytics.desc')}
      tabs={{
        items: [
          { key: 'dash' as const, label: t('analytics.tab.dash') },
          { key: 'badcase' as const, label: t('analytics.tab.badcase') },
        ],
        value: tab,
        onChange: setTab,
      }}
    >
      {tab === 'badcase'
        ? <Card headless><BadcaseTable t={t} api={api} /></Card>
        : data === undefined
          ? <p className={css.empty}>{t('list.empty')}</p>
          : (
            <>
              <KpiRow items={KPI_DEFS.map(({ key, pick }) => ({
                label: t(`analytics.kpi.${key}`),
                value: pick(data.kpi),
                delta: formatDelta(t, data.deltas[key]),
                tone: deltaTone(key, data.deltas[key]),
              }))} />
              <Card icon={IconDataOutlineRegular} title={t('analytics.chart.toolTrend')}>
                <ToolTrendChart data={data.toolTrend} />
              </Card>
              <Card icon={IconWarningOutlineRegular} title={t('analytics.card.failCauses')}>
                <RankList
                  rows={data.failCauses.map(item => ({ name: item.cause, count: item.count }))}
                  label={name => t(`cause.${name}`)}
                  unit={` ${t('analytics.unit.times')}`}
                />
              </Card>
              <Card icon={IconSlidersTwoOutlineRegular} title={t('analytics.card.topTools')}>
                <RankList
                  rows={data.topTools.map(item => ({ name: item.api, count: item.count }))}
                  label={name => <code>{name}</code>}
                  unit={` ${t('analytics.unit.times')}`}
                />
              </Card>
            </>
          )}
    </AdminPage>
  )
}
