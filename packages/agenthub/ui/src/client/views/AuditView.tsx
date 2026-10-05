/**
 * 审计日志 (Audit log): one project's tool-call history with server-side filters.
 *
 * The query surface always carries a project (BND-4) — the page therefore starts
 * by picking one and has no "all projects" mode. Status / user / tool are sent to
 * the server rather than filtered in the browser: the server holds the whole
 * history, and filtering locally would silently show only the current page.
 * Pagination is offset-based and driven by the returned total.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminPage, Card } from '../ui/kit.tsx'
import css from '../ui/admin.module.css'
import { AdminTable, type AdminColumn } from '../AdminTable.tsx'
import {
  errorMessage,
  type AuditRecord, type AuditStatus, type BadcaseCause, type ProjectOption,
} from '../api.ts'
import type { AgenthubLocaleKey } from '../locales.ts'
import { RiskTag } from './badges.tsx'
import type { ModuleViewProps } from './ToolsView.tsx'

/** Rows per page; the server clamps anything larger. */
const PAGE_SIZE = 50

/** The eight `badcases.category` values (DB 0012) offered when marking. */
const CAUSE_OPTIONS: readonly BadcaseCause[] = [
  'wrong_tool',
  'bad_param',
  'upstream_error',
  'permission_denied',
  'model_misunderstanding',
  'prompt_injection',
  'timeout',
  'unknown',
]

/** The four `audit_records.status` values plus "no filter". */
const STATUS_OPTIONS: readonly (AuditStatus | '')[] = ['', 'ok', 'error', 'denied', 'pending']

/** Status → locale key. `status` arrives as free text from the DB, so unknown
 * values fall back to the raw value instead of inventing a translation key. */
const STATUS_KEY: Readonly<Record<AuditStatus, AgenthubLocaleKey>> = {
  ok: 'audit.status.ok',
  error: 'audit.status.error',
  denied: 'audit.status.denied',
  pending: 'audit.status.pending',
}

/**
 * Localize one audit status.
 * @param t - locale binder.
 * @param status - raw `audit_records.status`.
 * @returns the localized label, or the raw value when it is outside the enum.
 */
function statusLabel(t: ModuleViewProps['t'], status: string): string {
  return status in STATUS_KEY ? t(STATUS_KEY[status as AuditStatus]) : status
}

/**
 * Render the audit log page.
 * @param props - the locale binder and the module data seam.
 * @returns the page element.
 */
export function AuditView({ t, api }: ModuleViewProps): ReactNode {
  const [projects, setProjects] = useState<readonly ProjectOption[]>([])
  const [projectId, setProjectId] = useState('')
  const [status, setStatus] = useState<AuditStatus | ''>('')
  const [userId, setUserId] = useState('')
  const [toolId, setToolId] = useState('')
  const [rows, setRows] = useState<readonly AuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | undefined>(undefined)
  /** Audit row whose mark form is open; `undefined` = all collapsed. */
  const [markingId, setMarkingId] = useState<string | undefined>(undefined)
  const [cause, setCause] = useState<BadcaseCause>('wrong_tool')
  const [note, setNote] = useState('')
  const [marked, setMarked] = useState(false)

  useEffect(() => {
    let live = true
    void api.listProjectOptions()
      .then((options) => {
        if (!live) return
        setProjects(options)
        setProjectId(current => current === '' ? options[0]?.id ?? '' : current)
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
    return () => { live = false }
  }, [api])

  /** Read one page; `page` is the offset the caller asked for, not a delta. */
  const load = useCallback((page: number): void => {
    if (projectId === '') return
    setError(undefined)
    void api.listAudit({
      projectId,
      ...(status === '' ? {} : { status }),
      ...(userId === '' ? {} : { userId }),
      ...(toolId === '' ? {} : { toolId }),
      limit: PAGE_SIZE,
      offset: page,
    })
      .then((result) => {
        setRows(result.items)
        setTotal(result.total)
        setOffset(page)
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api, projectId, status, userId, toolId])

  useEffect(() => { load(0) }, [load])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    load(0)
  }

  /** Open/close the mark form for one row, resetting the previous draft. */
  const toggleMarking = (row: AuditRecord): void => {
    setMarked(false)
    setCause('wrong_tool')
    setNote('')
    setMarkingId(current => (current === row.id ? undefined : row.id))
  }

  /** Register the verdict for the open row; the server upserts per audit record. */
  const submitMark = (event: FormEvent<HTMLFormElement>, row: AuditRecord): void => {
    event.preventDefault()
    setError(undefined)
    void api.markBadcase({ auditId: row.id, projectId, cause, note })
      .then(() => {
        setMarked(true)
        setMarkingId(undefined)
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }

  const columns: readonly AdminColumn<AuditRecord>[] = [
    { key: 'time', label: t('audit.col.time'), render: row => <span className={css.mono}>{row.createdAt.slice(0, 19).replace('T', ' ')}</span> },
    { key: 'tool', label: t('audit.col.tool'), render: row => <code>{row.toolName}</code> },
    { key: 'risk', label: t('audit.col.risk'), render: row => <RiskTag risk={row.risk as 'read' | 'write' | 'sensitive' | 'critical'} /> },
    { key: 'status', label: t('audit.col.status'), render: row => statusLabel(t, row.status) },
    { key: 'user', label: t('audit.col.user'), render: row => row.userId ?? t('audit.none') },
    { key: 'trace', label: t('audit.col.trace'), render: row => <code className={css.small}>{row.traceId.slice(0, 8)}</code> },
    {
      key: 'action',
      label: t('audit.col.action'),
      render: row => (
        <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); toggleMarking(row) }}>
          {t('badcase.action.mark')}
        </Button>
      ),
    },
  ]

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <AdminPage
      title={t('panel.audit')}
      desc={t('audit.desc')}
      actions={projects.length > 1
        ? (
          <select className={css.select} value={projectId} onChange={(event) => { setProjectId(event.target.value) }}>
            {projects.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        )
        : undefined}
    >
      <Card headless>
        <form className={css.form} onSubmit={submit}>
          <select
            className={css.select}
            value={status}
            onChange={(event) => { setStatus(event.target.value as AuditStatus | '') }}
          >
            {STATUS_OPTIONS.map(value => (
              <option key={value} value={value}>
                {value === '' ? t('audit.filter.allStatus') : statusLabel(t, value)}
              </option>
            ))}
          </select>
          <input
            className={css.input}
            name="userId"
            placeholder={t('audit.filter.user')}
            value={userId}
            onChange={(event) => { setUserId(event.target.value) }}
          />
          <input
            className={css.input}
            name="toolId"
            placeholder={t('audit.filter.tool')}
            value={toolId}
            onChange={(event) => { setToolId(event.target.value) }}
          />
          <Button variant="primary" size="sm" type="submit">{t('audit.filter.apply')}</Button>
        </form>
        <AdminTable<AuditRecord>
          columns={columns}
          rows={rows}
          rowKey={row => row.id}
          emptyLabel={t('audit.empty')}
          isExpanded={row => row.id === markingId}
          renderDetail={row => (
            <form className={css.form} onSubmit={(event) => { submitMark(event, row) }}>
              <select
                className={css.select}
                value={cause}
                onChange={(event) => { setCause(event.target.value as BadcaseCause) }}
              >
                {CAUSE_OPTIONS.map(value => (
                  <option key={value} value={value}>{t(`cause.${value}`)}</option>
                ))}
              </select>
              <input
                className={css.input}
                name="note"
                placeholder={t('badcase.field.note')}
                value={note}
                onChange={(event) => { setNote(event.target.value) }}
              />
              <Button variant="primary" size="sm" type="submit">{t('badcase.action.submit')}</Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => { setMarkingId(undefined) }}
              >{t('badcase.action.cancel')}</Button>
            </form>
          )}
        />
        {marked && <p className={css.hint}>{t('badcase.marked')}</p>}
        <div className={css.row}>
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => { load(Math.max(0, offset - PAGE_SIZE)) }}
          >{t('audit.page.prev')}</Button>
          <span className={`${css.small} ${css.muted}`}>
            {`${t('audit.page.label')}${String(page)} / ${String(pageCount)} · ${String(total)}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => { load(offset + PAGE_SIZE) }}
          >{t('audit.page.next')}</Button>
        </div>
      </Card>
      {error !== undefined && <p className={css.formError}>{`${t('common.actionFailed')}${error}`}</p>}
      <p className={css.hint}>{t('audit.hint')}</p>
    </AdminPage>
  )
}
