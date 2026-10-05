/**
 * Admin UI kit: the console pages' scaffolding. AdminPage follows the host
 * plugin-manager page head (28px top inset, 20px/500 title, secondary intro,
 * actions right) with the primitives SegmentedControl for page tabs; Card,
 * KpiRow, and Tag carry the shared list language on the same --dsw-* tokens.
 */

import { type ComponentType, type ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './admin.module.css'

/** Icon glyph shape shared by kit props. */
export type IconGlyph = ComponentType<{ size?: number | undefined }>

/** A page tab definition for AdminPage. */
export interface PageTab<K extends string = string> {
  readonly key: K
  readonly label: string
}

/** Props of the admin page scaffolding. */
export interface AdminPageProps<K extends string = string> {
  readonly title: string
  readonly desc?: string | undefined
  readonly actions?: ReactNode
  readonly tabs?: {
    readonly items: readonly PageTab<K>[]
    readonly value: K
    readonly onChange: (key: K) => void
  } | undefined
  readonly children: ReactNode
}

/**
 * Render the admin page scaffolding: the page head (title/desc + actions),
 * the optional SegmentedControl tab row, then the scrollable body column.
 * @param props - title / desc / actions / tabs plus the page body.
 * @returns the page element.
 */
export function AdminPage<K extends string = string>(props: AdminPageProps<K>): ReactNode {
  const { title, desc, actions, tabs, children } = props
  return (
    <div className={css.page}>
      <div className={css.pageHead}>
        <div>
          <h2 className={css.pageTitle}>{title}</h2>
          {desc !== undefined && desc !== '' && <p className={css.pageDesc}>{desc}</p>}
        </div>
        {actions !== undefined && <div className={css.toolbar}>{actions}</div>}
      </div>
      {tabs !== undefined && (
        <div className={css.pageTabs}>
          <SegmentedControl
            id="agenthub-page-tabs"
            label={title}
            value={tabs.value}
            options={tabs.items.map(item => ({ value: item.key, label: item.label }))}
            onChange={tabs.onChange}
          />
        </div>
      )}
      <div className={css.pageBody}>{children}</div>
    </div>
  )
}

/** Props of the card component. */
export interface CardProps {
  readonly icon?: IconGlyph | undefined
  readonly title?: string | undefined
  readonly actions?: ReactNode
  readonly headless?: boolean
  readonly children: ReactNode
}

/**
 * Render a list card: .card > .card-head (icon + title + actions) + body.
 * @param props - optional head parts and the card body.
 * @returns the card element.
 */
export function Card(props: CardProps): ReactNode {
  const { icon: Icon, title, actions, headless = false, children } = props
  const head = !headless && (title !== undefined || actions !== undefined || Icon !== undefined)
  return (
    <section className={css.card}>
      {head && (
        <div className={css.cardHead}>
          {Icon !== undefined && <Icon size={15} />}
          {title !== undefined && <span>{title}</span>}
          {(actions !== undefined || title !== undefined) && <span className={css.cardHeadActions}>{actions}</span>}
        </div>
      )}
      {headless ? children : <div className={css.cardBody}>{children}</div>}
    </section>
  )
}

/** One KPI tile definition. */
export interface KpiItem {
  readonly label: string
  readonly value: string
  readonly delta: string
  readonly tone: 'up' | 'down' | 'flat'
}

/**
 * Render the KPI row.
 * @param props.items - ordered tiles.
 * @returns the KPI row element.
 */
export function KpiRow({ items }: { items: readonly KpiItem[] }): ReactNode {
  return (
    <div className={css.kpiRow}>
      {items.map(item => (
        <div key={item.label} className={css.kpi}>
          <div className={css.kpiLabel}>{item.label}</div>
          <div className={css.kpiValue}>{item.value}</div>
          <div className={
            item.tone === 'up' ? `${css.kpiDelta} ${css.kpiDeltaUp}`
              : item.tone === 'down' ? `${css.kpiDelta} ${css.kpiDeltaDown}`
                : css.kpiDelta
          }>{item.delta}</div>
        </div>
      ))}
    </div>
  )
}

/** Tag tone (risk read / write / critical). */
export type TagTone = 'read' | 'write' | 'critical' | 'neutral'

/**
 * Render a tag chip.
 * @param props.tone - palette selector (default neutral: outline-less base tag).
 * @param props.children - the chip copy, owned by the render site.
 * @returns the tag element.
 */
export function Tag({ tone = 'neutral', children }: { tone?: TagTone | undefined; children?: ReactNode }): ReactNode {
  const cls = tone === 'read' ? css.tagRead
    : tone === 'write' ? css.tagWrite
      : tone === 'critical' ? css.tagCritical
        : css.tag
  return <span className={cls}>{children}</span>
}
