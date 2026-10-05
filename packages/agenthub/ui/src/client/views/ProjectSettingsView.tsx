/**
 * 项目设置 (Project settings): the five-tab project page — Agent / Tool Set /
 * Memory / 文件 / 成员.
 *
 * Backend coverage is uneven by design: the Memory tab reads and writes real data
 * (`/projects/:id/memories`, 阶段 C), while Agent / Tool Set / 文件 / 成员 have no
 * backend owner yet and render from prototype fixtures. Settings are per-project
 * isolated: the page holds one record per project, and the head switcher selects
 * which project is shown; the head "new project" button creates one through the
 * seam (the form is pinned open on the empty page). The switcher is a
 * width-capped native select because project names are unbounded user data and
 * a segmented strip would overflow.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminPage, Card, Tag } from '../ui/kit.tsx'
import css from '../ui/admin.module.css'
import { AdminTable, type AdminColumn } from '../AdminTable.tsx'
import {
  errorMessage, type AgenthubApi, type ProjectFileItem, type ProjectMemberItem,
  type ProjectSettingsRecord, type ToolRisk,
} from '../api.ts'
import type { Translate } from '../locales.ts'
import { RiskTag } from './badges.tsx'
import type { ModuleViewProps } from './ToolsView.tsx'

/** The five prototype tabs. */
type ProjectTab = 'agent' | 'tools' | 'memory' | 'files' | 'members'

/** The five prototype tabs, in display order. The values are state discriminants,
 * not product copy — their labels come from `project.tab.*` keys. */
const PROJECT_TAB_KEYS: readonly ProjectTab[] = ['agent', 'tools', 'memory', 'files', 'members'] as const
/**
 * Render the project settings page.
 * @param props - the locale binder and the module data seam.
 * @returns the page element.
 */
export function ProjectSettingsView({ t, api }: ModuleViewProps): ReactNode {
  const [tab, setTab] = useState<ProjectTab>('agent')
  const [records, setRecords] = useState<readonly ProjectSettingsRecord[]>([])
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  /** Re-read every project's settings; the initial load and the switcher path. */
  const reload = useCallback((): void => {
    setError(undefined)
    void api.listProjectSettings()
      .then((next) => {
        setRecords(next)
        setProjectId(current => current ?? next[0]?.id)
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api])

  /**
   * Re-read ONE project after a memory mutation: replacing just that record keeps
   * the other projects' rows stable and avoids refetching every project's memory.
   */
  const reloadProject = useCallback((targetId: string): void => {
    setError(undefined)
    void api.listProjectSettingsFor(targetId)
      .then((next) => {
        setRecords(current => current.map(item => (item.id === next.id ? next : item)))
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api])

  useEffect(() => { reload() }, [reload])

  const submitCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const name = newName.trim()
    if (name === '') return
    setBusy(true)
    setError(undefined)
    void api.createProject({ name })
      .then((created) => {
        setAdding(false)
        setNewName('')
        setProjectId(created.id)
        reload()
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusy(false) })
  }

  const current = useMemo(
    () => records.find(record => record.id === projectId) ?? records[0],
    [records, projectId],
  )

  const removeProject = (): void => {
    if (current === undefined || busy) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    const id = current.id
    setBusy(true)
    setError(undefined)
    void api.deleteProject(id)
      .then(() => {
        setConfirmingDelete(false)
        setProjectId(undefined)
        setRecords(existing => existing.filter(item => item.id !== id))
        reload()
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <AdminPage
      title={current === undefined ? t('panel.project') : `${current.name} · ${t('project.settingsSuffix')}`}
      desc={current === undefined
        ? undefined
        : `${t('project.systemLabel')}${current.system}　·　${t('project.isolated')}`}
      actions={(
        <>
          {records.length > 1 && (
            /*
             * Native <select> rather than a segmented control: project names are
             * user data of unbounded length, and a segmented strip lays every name
             * out side by side until it overflows the page head. The select is
             * width-capped and truncates, so added projects cannot break the layout.
             */
            <select
              className={`${css.select} ${css.projectPicker}`}
              aria-label={t('project.pickLabel')}
              value={current?.id ?? ''}
              onChange={(event) => { setProjectId(event.target.value); setConfirmingDelete(false) }}
            >
              {records.map(record => (
                <option key={record.id} value={record.id}>{record.name}</option>
              ))}
            </select>
          )}
          {current !== undefined && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={removeProject}
            >{confirmingDelete ? t('common.deleteconfirm') : t('common.delete')}</Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={() => { setAdding(current => !current); setConfirmingDelete(false) }}
          >
            {t('project.create')}
          </Button>
        </>
      )}
      tabs={{
        items: PROJECT_TAB_KEYS.map(key => ({ key, label: t(`project.tab.${key}`) })),
        value: tab,
        onChange: setTab,
      }}
    >
      {error !== undefined && <p className={css.hint}>{error}</p>}
      {/* The create form: folded behind the head button once projects exist,
          pinned open on the empty page so the first project is one field away. */}
      {(adding || current === undefined) && (
        <Card title={t('project.create')}>
          {current === undefined && <p className={css.empty}>{t('project.create.empty')}</p>}
          <form className={css.formStack} onSubmit={submitCreate}>
            <label className={css.fieldLabel} htmlFor="project-create-name">{t('project.create.name')}</label>
            <input
              id="project-create-name"
              className={css.input}
              value={newName}
              placeholder={t('project.create.nameHint')}
              onChange={(event) => { setNewName(event.target.value) }}
            />
            <div className={css.row}>
              <Button size="sm" variant="primary" type="submit" disabled={busy || newName.trim() === ''}>
                {t('project.create.submit')}
              </Button>
              {current !== undefined && (
                <Button size="sm" variant="ghost" type="button" onClick={() => { setAdding(false); setNewName('') }}>
                  {t('project.create.cancel')}
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}
      {current !== undefined
        ? tab === 'agent'
          ? <AgentTab record={current} t={t} />
          : tab === 'tools'
            ? <ToolSetTab record={current} t={t} />
            : tab === 'memory'
              ? (
                <MemoryTab
                  record={current}
                  t={t}
                  onChanged={reloadProject}
                  api={api}
                />
              )
              : tab === 'files'
                ? <FilesTab record={current.files} t={t} />
                : <MembersTab record={current.members} t={t} />
        : null}
    </AdminPage>
  )
}

/** Agent tab: the bound agent's profile card and its note line. */
function AgentTab({ record, t }: { record: ProjectSettingsRecord; t: Translate }): ReactNode {
  const agent = record.agent
  return (
    <>
      <Card title={agent.name} actions={<span className={`${css.small} ${css.muted}`}>{`${t('project.agent.model')}${agent.model}`}</span>}>
        <p className={css.detailDesc}>{agent.desc}</p>
        <div className={css.kv}><span className={css.kvKey}>{t('project.agent.approvalLabel')}</span><span>{agent.approval}</span></div>
        <div className={css.kv}><span className={css.kvKey}>{t('project.agent.memoryLabel')}</span><span>{agent.memory}</span></div>
        <div className={css.kv}><span className={css.kvKey}>{t('project.agent.skills')}</span><span>{agent.skills.join('、') || t('tools.approval.none')}</span></div>
        <div className={css.kv}><span className={css.kvKey}>{t('project.agent.mcp')}</span><span>{agent.mcp.join('、') || t('tools.approval.none')}</span></div>
      </Card>
      <p className={css.hint}>{t('project.agent.note')}</p>
    </>
  )
}

/** Tool Set tab: the fail-closed allowlist — unchecked means invisible to the agent. */
function ToolSetTab({ record, t }: { record: ProjectSettingsRecord; t: Translate }): ReactNode {
  return (
    <Card title={t('project.tools.head')} actions={<span className={`${css.small} ${css.muted}`}>{t('project.tools.hint')}</span>}>
      <AdminTable<{ id: string; name: string; api: string; risk: ToolRisk }>
        columns={[
          {
            key: 'assign',
            label: '',
            render: row => (
              <input
                type="checkbox"
                checked={record.toolSet.includes(row.id)}
                disabled
                title={t('common.p3')}
                aria-label={row.name}
              />
            ),
          },
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
          { key: 'risk', label: t('tools.col.risk'), render: row => <RiskTag risk={row.risk} /> },
        ]}
        rows={record.toolOptions}
        rowKey={row => row.id}
        emptyLabel={t('list.empty')}
      />
    </Card>
  )
}

/**
 * Memory tab: extraction candidates awaiting confirmation, then confirmed memories.
 *
 * Candidates are not injected until confirmed, so they render in their own section
 * with confirm/reject actions. Confirmed memories carry lock (always injected),
 * soft delete (row retained) and hard delete (row removed, double-confirmed).
 * Hard delete asks for a second click on the same control instead of a browser
 * dialog: the admin kit owns no dialog component, and the two-step control keeps
 * the affordance inside the page (keyboard reachable, no global API).
 * Every mutation reloads that one project from the server rather than patching
 * local state, so the view cannot drift from what the backend stored.
 */
function MemoryTab({ record, t, onChanged, api }: {
  record: ProjectSettingsRecord
  t: Translate
  onChanged: (projectId: string) => void
  api: AgenthubApi
}): ReactNode {
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const projectId = record.id
  const run = (targetId: string, action: () => Promise<unknown>): void => {
    setBusyId(targetId)
    setError(undefined)
    setConfirmingId(undefined)
    void action()
      .then(() => { onChanged(projectId) })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusyId(undefined) })
  }

  const candidates = record.memoryCandidates
  return (
    <>
      <Card
        title={`${t('project.memory.candidates')} (${candidates.length})`}
        actions={<span className={`${css.small} ${css.muted}`}>{t('project.memory.candidatesHint')}</span>}
      >
        {candidates.length === 0
          ? <p className={css.empty}>{t('project.memory.candidatesEmpty')}</p>
          : candidates.map(item => (
            <div key={item.id} className={css.memRow}>
              <div className={css.row}>
                <span className={css.memContent}>{item.content}</span>
                <Button size="sm" disabled={busyId === item.id} onClick={() => {
                  run(item.id, () => api.confirmMemory(projectId, item.id))
                }}>
                  {t('project.memory.confirm')}
                </Button>
                <Button size="sm" disabled={busyId === item.id} onClick={() => {
                  run(item.id, () => api.rejectMemory(projectId, item.id))
                }}>
                  {t('project.memory.reject')}
                </Button>
              </div>
            </div>
          ))}
      </Card>

      <Card
        title={`${t('project.memory.head')} (${record.memories.length})`}
        actions={(
          <Button size="sm" icon={<IconPlusOutlineRegular size={13} />} disabled title={t('common.p3')}>
            {t('project.memory.add')}
          </Button>
        )}
      >
        {error !== undefined && <p className={css.hint}>{error}</p>}
        {record.memories.length === 0
          ? <p className={css.empty}>{t('project.memory.empty')}</p>
          : record.memories.map(item => (
            <div key={item.id} className={css.memRow}>
              <div className={css.row}>
                <span className={css.memContent}>{item.content}</span>
                {item.locked && <Tag tone="read">{t('project.memory.locked')}</Tag>}
                <Button size="sm" disabled={busyId === item.id} onClick={() => {
                  run(item.id, () => api.setMemoryLocked(projectId, item.id, !item.locked))
                }}>
                  {item.locked ? t('project.memory.unlock') : t('project.memory.locked')}
                </Button>
                <Button size="sm" disabled={busyId === item.id} onClick={() => {
                  run(item.id, () => api.deleteMemory(projectId, item.id))
                }}>
                  {t('project.memory.softDelete')}
                </Button>
                <Button
                  size="sm"
                  disabled={busyId === item.id}
                  title={confirmingId === item.id ? t('project.memory.hardDeleteConfirm') : undefined}
                  onClick={() => {
                    // First click arms the control, second click deletes: no global dialog.
                    if (confirmingId !== item.id) {
                      setConfirmingId(item.id)
                      return
                    }
                    run(item.id, () => api.deleteMemory(projectId, item.id, true))
                  }}
                >
                  {confirmingId === item.id ? t('project.memory.hardDeleteConfirm') : t('project.memory.hardDelete')}
                </Button>
              </div>
              <div className={`${css.small} ${css.muted}`}>
                {`${t('project.memory.updated')}${item.updatedAt.slice(0, 10)}`}
              </div>
            </div>
          ))}
      </Card>
    </>
  )
}

/** Files tab: uploaded files with their in-context markers. */
function FilesTab({ record, t }: { record: readonly ProjectFileItem[]; t: Translate }): ReactNode {
  const columns: readonly AdminColumn<ProjectFileItem>[] = [
    { key: 'name', label: t('project.files.col.name'), render: row => <code className={css.small}>{row.name}</code> },
    { key: 'size', label: t('project.files.col.size'), render: row => row.size },
    { key: 'inCtx', label: t('project.files.col.inCtx'), render: row => row.inCtx ? t('project.files.yes') : t('project.files.no') },
    { key: 'updated', label: t('project.files.col.updated'), render: row => <span className={css.muted}>{row.updated}</span> },
  ]
  return (
    <Card
      title={t('project.files.head')}
      actions={<Button size="sm" disabled title={t('common.p3')}>{t('project.files.upload')}</Button>}
    >
      <AdminTable<ProjectFileItem> columns={columns} rows={record} rowKey={row => row.id} emptyLabel={t('project.files.empty')} />
    </Card>
  )
}

/** Members tab: the project roster with roles, plus the RBAC note. */
function MembersTab({ record, t }: { record: readonly ProjectMemberItem[]; t: Translate }): ReactNode {
  const columns: readonly AdminColumn<ProjectMemberItem>[] = [
    { key: 'name', label: t('project.members.col.name'), render: row => row.name },
    { key: 'role', label: t('project.members.col.role'), render: row => <Tag tone="read">{row.role}</Tag> },
    { key: 'email', label: t('project.members.col.email'), render: row => <code className={css.small}>{row.email}</code> },
    { key: 'joined', label: t('project.members.col.joined'), render: row => <span className={css.muted}>{row.joined}</span> },
  ]
  return (
    <>
      <Card
        title={t('project.members.head')}
        actions={<Button size="sm" icon={<IconPlusOutlineRegular size={13} />} disabled title={t('common.p3')}>{t('project.members.add')}</Button>}
      >
        <AdminTable<ProjectMemberItem> columns={columns} rows={record} rowKey={row => row.email} emptyLabel={t('list.empty')} />
      </Card>
      <p className={css.hint}>{t('project.members.note')}</p>
    </>
  )
}
