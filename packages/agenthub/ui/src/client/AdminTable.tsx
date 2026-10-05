/**
 * AdminTable: the self-assembled grid primitive for the console pages (the
 * upstream ui-primitives ship no Table). Columns are configured, cells are
 * caller-rendered so badges and dots compose freely; an optional detail
 * renderer supports the expandable row pattern (Tool 中心). Styling lives in
 * admin.module.css against `--dsw-*` tokens.
 */

import { Fragment, type ReactNode } from 'react'
import css from './ui/admin.module.css'

/** One column: header label plus a caller-owned cell renderer. */
export interface AdminColumn<Row> {
  readonly key: string
  readonly label: string
  readonly render: (row: Row) => ReactNode
}

/**
 * Render a read-only admin table.
 * @param props.columns - ordered column config.
 * @param props.rows - row records in display order.
 * @param props.rowKey - stable key extractor per row.
 * @param props.emptyLabel - localized copy for the zero-row case.
 * @param props.onRowClick - row activation (click); pairs with `isExpanded` for the expandable pattern.
 * @param props.isExpanded - whether a row's detail is open (no detail when omitted).
 * @param props.renderDetail - detail content rendered under an expanded row.
 * @returns the table element.
 */
export function AdminTable<Row>(props: {
  columns: readonly AdminColumn<Row>[]
  rows: readonly Row[]
  rowKey: (row: Row) => string
  emptyLabel: string
  onRowClick?: (row: Row) => void
  isExpanded?: (row: Row) => boolean
  renderDetail?: (row: Row) => ReactNode
}): ReactNode {
  const { columns, rows, rowKey, emptyLabel, onRowClick, isExpanded, renderDetail } = props
  if (rows.length === 0) {
    return <p className={css.empty}>{emptyLabel}</p>
  }
  return (
    <table className={css.grid}>
      <thead>
        <tr>
          {columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row)
          const expanded = isExpanded?.(row) === true
          return (
            <Fragment key={key}>
              <tr
                onClick={onRowClick === undefined ? undefined : () =>{  onRowClick(row) }}
              >
                {columns.map(column => <td key={column.key}>{column.render(row)}</td>)}
              </tr>
              {expanded && renderDetail !== undefined
                ? <tr className={css.detailRow}><td colSpan={columns.length}>{renderDetail(row)}</td></tr>
                : null}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}
