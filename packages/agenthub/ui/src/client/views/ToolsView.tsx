/**
 * Tool 中心 (Tool Center): the Global Tool Registry page, composed from the
 * admin kit per the host plugin-manager page — AdminPage (title/desc/「从连接
 * 扫描」action + SegmentedControl filter tabs) over the registry table in a
 * card, rows expanding to params/result. `draft` filters by status, the
 * others by risk. Referencing projects resolve ids to names through the
 * project options seam.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminPage, Card, type PageTab } from '../ui/kit.tsx'
import css from '../ui/admin.module.css'
import { AdminTable, type AdminColumn } from '../AdminTable.tsx'
import { errorMessage, type ProjectOption, type ToolRecord, type ToolRisk } from '../api.ts'
import type { Translate } from '../locales.ts'
import { RiskTag, ToolStatusTag } from './badges.tsx'

/** The prototype's filter tab set; `draft` filters by status, the others by risk. */
type ToolFilter = 'all' | ToolRisk | 'draft'

const FILTERS: readonly ToolFilter[] = ['all', 'read', 'write', 'sensitive', 'critical', 'draft'] as const

/** 每页行数：导入大规格文档后工具可达上千条，一次全渲染会卡住浏览器。 */
const PAGE_SIZE = 50

/** Props shared by every console page. */
export interface ModuleViewProps {
  readonly t: Translate
  readonly api: import('../api.ts').AgenthubApi
}

/**
 * Render the Tool Center page.
 * @param props - the locale binder and the module data seam.
 * @returns the page element.
 */
export function ToolsView({ t, api }: ModuleViewProps): ReactNode {
  const [tools, setTools] = useState<readonly ToolRecord[]>([])
  const [projects, setProjects] = useState<readonly ProjectOption[]>([])
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState<ToolFilter>('all')
  /** 当前页码（1 起）。筛选变化时回到第 1 页，否则会停在一个空页上。 */
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [enablingAll, setEnablingAll] = useState(false)
  const enablingAllRef = useRef(false)
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const reload = useCallback((): void => {
    void Promise.all([api.listTools(), api.listProjectOptions()])
      .then(([rows, options]) => {
        setTools(rows)
        setProjects(options)
        setProjectId(current => current ?? options[0]?.id)
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api])

  useEffect(() => { reload() }, [reload])

  const setEnabled = (row: ToolRecord, enabled: boolean): void => {
    setBusyId(row.id)
    setError(undefined)
    void api.setToolEnabled(row.id, enabled)
      .then(() => { reload() })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusyId(undefined) })
  }

  const removeTool = (row: ToolRecord): void => {
    if (projectId === undefined || busyId !== undefined) return
    if (confirmingId !== row.id) {
      setConfirmingId(row.id)
      return
    }
    setBusyId(row.id)
    setError(undefined)
    void api.deleteTool(projectId, row.id)
      .then(() => {
        setConfirmingId(undefined)
        reload()
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusyId(undefined) })
  }

  const enableAll = (): void => {
    if (projectId === undefined || enablingAllRef.current) return
    enablingAllRef.current = true
    setEnablingAll(true)
    setError(undefined)
    void api.enableAllTools(projectId)
      .then(() => { reload() })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => {
        enablingAllRef.current = false
        setEnablingAll(false)
      })
  }

  const projectName = new Map(projects.map(option => [option.id, option.name]))
  const pendingInProject = projectId === undefined
    ? 0
    : tools.filter(tool => tool.usedBy.includes(projectId) && tool.status !== 'enabled').length
  const visible = tools.filter(tool =>
    projectId !== undefined
    && tool.usedBy.includes(projectId)
    && (filter === 'all' ? true : filter === 'draft' ? tool.status === 'draft' : tool.risk === filter))
  // 服务端一次返回全量工具（导入后可达上千条），因此分页在客户端做：
  // 渲染上千行会让浏览器卡住，而筛选与翻页都只影响"显示哪些"。
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const toggle = (id: string): void => {
    setExpanded(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id])
  }
  const tabItems: readonly PageTab<ToolFilter>[] = FILTERS.map(value => ({
    key: value,
    label: t(`tools.filter.${value}`),
  }))

  const columns: readonly AdminColumn<ToolRecord>[] = [
    {
      key: 'tool',
      label: t('tools.col.tool'),
      render: row => (
        <span className={css.toolCell}>
          <span>{row.name}</span>
          <code>{row.api}</code>
        </span>
      ),
    },
    { key: 'method', label: t('tools.col.method'), render: row => <code className={css.mono}>{`${row.method} ${row.path}`}</code> },
    { key: 'source', label: t('tools.col.source'), render: row => row.source },
    { key: 'risk', label: t('tools.col.risk'), render: row => <RiskTag risk={row.risk} /> },
    {
      key: 'approval',
      label: t('tools.col.approval'),
      render: row => row.approval ? t('tools.approval.required') : t('tools.approval.none'),
    },
    { key: 'status', label: t('tools.col.status'), render: row => <ToolStatusTag status={row.status} t={t} /> },
    {
      key: 'usedBy',
      label: t('tools.col.usedBy'),
      render: row => row.usedBy.length === 0
        ? t('tools.approval.none')
        : row.usedBy.map(id => projectName.get(id) ?? id).join('、'),
    },
    {
      key: 'actions',
      label: t('tools.col.actions'),
      render: row => (
        <span className={css.row}>
          <Button
            size="sm"
            variant="outline"
            disabled={busyId === row.id || enablingAll}
            onClick={(event) => { event.stopPropagation(); setEnabled(row, row.status !== 'enabled') }}
          >{row.status === 'enabled' ? t('tools.action.disable') : t('tools.action.enable')}</Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busyId === row.id || enablingAll || projectId === undefined}
            onClick={(event) => { event.stopPropagation(); removeTool(row) }}
          >{confirmingId === row.id ? t('common.deleteconfirm') : t('common.delete')}</Button>
        </span>
      ),
    },
  ]

  return (
    <AdminPage<ToolFilter>
      title={t('panel.tools')}
      desc={t('tools.desc')}
      actions={(
        <>
          <select
            className={css.select}
            aria-label={t('project.pickLabel')}
            value={projectId ?? ''}
            onChange={(event) => { setProjectId(event.target.value); setPage(1) }}
          >
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={enablingAll || pendingInProject === 0}
            onClick={enableAll}
          >{t('tools.action.enableall')}</Button>
          <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={14} />} disabled title={t('approval.action.placeholder')}>
            {t('tools.scannew')}
          </Button>
        </>
      )}
      tabs={{ items: tabItems, value: filter, onChange: (next) => { setFilter(next); setPage(1) } }}
    >
      <Card headless>
        {/* 固定高度 + 内滚：表格不随行数增长把整页拉长，翻页条始终可达。 */}
        <div className={css.tableScroll}>
          <AdminTable<ToolRecord>
            columns={columns}
            rows={pageRows}
            rowKey={row => row.id}
            emptyLabel={t('tools.empty')}
            onRowClick={(row) => {
              toggle(row.id)
            }}
            isExpanded={row => expanded.includes(row.id)}
            renderDetail={row => (
              <div>
                <p className={css.detailDesc}>{row.desc}</p>
                <div className={css.detailTitle}>{t('tools.detail.params')}</div>
                <pre className={css.detailPre}>{row.params}</pre>
                <div className={css.detailTitle}>{t('tools.detail.result')}</div>
                <pre className={css.detailPre}>{row.result}</pre>
              </div>
            )}
          />
        </div>
        <div className={css.row}>
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage <= 1}
            onClick={() => { setPage(currentPage - 1) }}
          >{t('audit.page.prev')}</Button>
          <span className={`${css.small} ${css.muted}`}>
            {`${t('audit.page.label')}${String(currentPage)} / ${String(pageCount)} · ${String(visible.length)}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage >= pageCount}
            onClick={() => { setPage(currentPage + 1) }}
          >{t('audit.page.next')}</Button>
        </div>
      </Card>
      {error !== undefined && <p className={css.formError}>{`${t('common.actionFailed')}${error}`}</p>}
      <p className={css.hint}>{t('tools.rowhint')}</p>
    </AdminPage>
  )
}
