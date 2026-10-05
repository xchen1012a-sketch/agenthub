/**
 * The lightweight section pages served from this module (审批中心) plus the
 * Badcase table shared with the AI 运营 Badcase tab: real list loads through the
 * module seam composed from the admin kit — AdminPage scaffolding around the
 * shared grid table. Approve/reject post the decision and reload the list.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminPage, Card } from '../ui/kit.tsx'
import css from '../ui/admin.module.css'
import { AdminTable, type AdminColumn } from '../AdminTable.tsx'
import { errorMessage, type ApprovalRecord, type BadcaseRecord } from '../api.ts'
import { ApprovalStatusTag, BadcaseStatusTag, CauseText, RiskTag } from './badges.tsx'
import type { ModuleViewProps } from './ToolsView.tsx'

/**
 * Run one async list loader into state, staying live-safe across unmounts.
 * `loader` must be a stable reference (a method of the module-level api
 * object) so the effect does not refetch every render.
 * @param loader - stable async list loader.
 * @returns the current rows plus a `reload` that re-runs the loader after a write.
 */
function useList<Row>(loader: () => Promise<readonly Row[]>): {
  readonly rows: readonly Row[]
  readonly reload: () => void
} {
  const [rows, setRows] = useState<readonly Row[]>([])
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let live = true
    void loader().then((next) => {
      if (live) setRows(next)
    })
    return () => { live = false }
  }, [loader, generation])
  return { rows, reload: () => { setGeneration(current => current + 1) } }
}

/** 审批中心: pending decisions first-class; approve/reject POST then reload. */
export function ApprovalView({ t, api }: ModuleViewProps): ReactNode {
  const [rows, setRows] = useState<readonly ApprovalRecord[]>([])
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const reload = useCallback((): void => {
    void api.listApprovals()
      .then(setRows)
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api])

  useEffect(() => { reload() }, [reload])

  const decide = (id: string, decision: 'approve' | 'reject'): void => {
    setBusyId(id)
    setError(undefined)
    void api.decideApproval(id, decision)
      .then(() => { reload() })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusyId(undefined) })
  }

  const columns: readonly AdminColumn<ApprovalRecord>[] = [
    { key: 'time', label: t('approval.col.time'), render: row => row.createdAt },
    { key: 'user', label: t('approval.col.user'), render: row => row.user },
    { key: 'project', label: t('approval.col.project'), render: row => row.project },
    {
      key: 'tool',
      label: t('approval.col.tool'),
      render: row => (
        <span className={css.toolCell}>
          <span>{row.toolLabel}</span>
          <span className={css.muted}>{row.detail}</span>
        </span>
      ),
    },
    { key: 'risk', label: t('approval.col.risk'), render: row => <RiskTag risk={row.risk} /> },
    { key: 'status', label: t('approval.col.status'), render: row => <ApprovalStatusTag status={row.status} t={t} /> },
    {
      key: 'actions',
      label: t('approval.col.actions'),
      render: row => row.status === 'pending'
        ? (
          <span className={css.row}>
            <Button
              size="sm"
              variant="outline"
              disabled={busyId === row.id}
              onClick={(event) => { event.stopPropagation(); decide(row.id, 'approve') }}
            >{t('approval.action.approve')}</Button>
            <Button
              size="sm"
              variant="outline"
              className={css.btnDanger}
              disabled={busyId === row.id}
              onClick={(event) => { event.stopPropagation(); decide(row.id, 'reject') }}
            >{t('approval.action.reject')}</Button>
          </span>
        )
        : <span className={css.muted}>—</span>,
    },
  ]
  return (
    <AdminPage title={t('panel.approvals')} desc={t('approval.desc')}>
      <Card headless>
        <AdminTable<ApprovalRecord> columns={columns} rows={rows} rowKey={row => row.id} emptyLabel={t('list.empty')} />
      </Card>
      {error !== undefined && <p className={css.formError}>{`${t('common.actionFailed')}${error}`}</p>}
    </AdminPage>
  )
}

/**
 * Badcase 表格体：Badcase 页与 AI 运营的 Badcase 页签共用。问题列带回答摘要，
 * 行展开看 Agent 回答全文、根因分析与 Trace（session · tool · 时间）。
 */
export function BadcaseTable({ t, api }: ModuleViewProps): ReactNode {
  const { rows, reload } = useList(useCallback(() => api.listBadcases(), [api]))
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const toggle = (id: string): void => {
    setExpanded(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id])
  }
  /**
   * Close one badcase. The row carries no project id, so the write is keyed by
   * the badcase id alone; the server still enforces membership on the audit
   * record's project.
   */
  const resolve = (id: string): void => {
    setError(undefined)
    void api.resolveBadcase(id)
      .then(() => { reload() })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }
  const columns: readonly AdminColumn<BadcaseRecord>[] = [
    { key: 'time', label: t('badcase.col.time'), render: row => row.createdAt },
    {
      key: 'question',
      label: t('badcase.col.question'),
      render: row => (
        <span className={css.toolCell}>
          <span>{row.question}</span>
          <span className={`${css.muted} ${css.small} ${css.answerLine}`}>{row.answer}</span>
        </span>
      ),
    },
    { key: 'cause', label: t('badcase.col.cause'), render: row => <CauseText cause={row.cause} t={t} /> },
    { key: 'project', label: t('badcase.col.project'), render: row => row.project },
    { key: 'status', label: t('badcase.col.status'), render: row => <BadcaseStatusTag status={row.status} t={t} /> },
    {
      key: 'action',
      label: t('audit.col.action'),
      render: row => row.status === 'resolved'
        ? null
        : (
          <Button
            size="sm"
            variant="outline"
            onClick={(event) => { event.stopPropagation(); resolve(row.id) }}
          >{t('badcase.action.resolve')}</Button>
        ),
    },
  ]
  return (
    <>
      <AdminTable<BadcaseRecord>
        columns={columns}
        rows={rows}
        rowKey={row => row.id}
        emptyLabel={t('list.empty')}
        onRowClick={(row) => { toggle(row.id) }}
        isExpanded={row => expanded.includes(row.id)}
        renderDetail={row => (
          <div>
            <div className={css.detailTitle}>{t('badcase.detail.answer')}</div>
            <p className={css.detailDesc}>{row.answer}</p>
            <div className={css.detailTitle}>{t('badcase.detail.causeDetail')}</div>
            <p className={css.detailDesc}>{row.causeDetail}</p>
            <div className={css.detailTitle}>{t('badcase.detail.trace')}</div>
            <code className={css.traceLine}>
              {`${t('badcase.trace.session')} ${row.session} · ${t('badcase.trace.tool')} ${row.tool} · ${row.createdAt}`}
            </code>
          </div>
        )}
      />
      {error !== undefined && <p className={css.formError}>{`${t('common.actionFailed')}${error}`}</p>}
      <p className={css.hint}>{t('badcase.hint')}</p>
    </>
  )
}
