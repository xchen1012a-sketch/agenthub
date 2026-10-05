/**
 * 系统连接 (Connections): one card per external system — icon, name, health
 * chip, scan action, and the meta row (baseUrl, ingest type, auth, published
 * tool count, last check). Login stays in the conversation card, one employee
 * at a time. This page does not collect or share a token.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  Button, IconApiOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AdminPage, Card, Tag } from '../ui/kit.tsx'
import css from '../ui/admin.module.css'
import {
  errorMessage, type AgenthubApi, type ConnectionHealthRecord, type ProjectOption, type ScanProgressRecord, type ScanReceipt,
} from '../api.ts'
import type { Translate } from '../locales.ts'
import { ConnectionHealth } from './badges.tsx'
import type { ModuleViewProps } from './ToolsView.tsx'

/**
 * Render the Connections page.
 * @param props - the locale binder and the module data seam.
 * @returns the page element.
 */
export function ConnectionsView({ t, api }: ModuleViewProps): ReactNode {
  const [rows, setRows] = useState<readonly ConnectionHealthRecord[]>([])
  const [projects, setProjects] = useState<readonly ProjectOption[]>([])
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [page, setPage] = useState<'list' | 'allowlist'>('list')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [frontendUrl, setFrontendUrl] = useState('')
  /**
   * 创建时就带白名单。
   *
   * 指向自建内网系统时，`openapi_url` 会在**创建那一刻**被 C-4 拦下；若白名单只能
   * 在创建后补配，用户就卡在一个自己解不开的循环里（先建 → 被拒 → 无从授权）。
   */
  const [busy, setBusy] = useState(false)
  const [receipts, setReceipts] = useState<Readonly<Record<string, ScanReceipt>>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined)
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined)
  /** 正在展示进度的扫描（`undefined` = 弹窗关闭）。 */
  const [scanning, setScanning] = useState<{ connectionId: string; label: string } | undefined>(undefined)
  /**
   * 首屏就拉到"上次扫描结果"的连接存在性。
   *
   * 状态在服务端，所以刷新页面后仍能显示上次结果——这正是"关闭后状态保持"的一半：
   * 任务不因关窗中断，结果也不因刷新丢失。
   */
  const [lastScan, setLastScan] = useState<Readonly<Record<string, ScanProgressRecord | null>>>({})

  const reload = useCallback((): void => {
    void api.listConnectionHealth()
      .then((next) => {
        setRows(next)
        // 同时取每个连接的上次扫描状态：刷新后仍能显示结果（状态在服务端）。
        void Promise.all(next.map(async row => [row.id, await api.getScanProgress(row.id)] as const))
          .then((entries) => { setLastScan(Object.fromEntries(entries)) })
          .catch(() => { /* 进度不可用不影响列表 */ })
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api])

  useEffect(() => {
    reload()
    // Project id for credential binding comes from the real project list (the
    // settings records themselves stay mock until P4).
    void api.listProjectOptions()
      .then((options) => {
        setProjects(options)
        setProjectId(current => current ?? options[0]?.id)
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }, [api, reload])

  const resetForm = (): void => {
    setName('')
    setBaseUrl('')
    setFrontendUrl('')
  }

  /**
   * 解析白名单文本：换行 / 逗号 / 分号都算分隔符。
   * @param raw - 表单原文。
   * @returns 主机项；空文本得到空数组（即全禁）。
   */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (projectId === undefined) {
      setError(t('connections.form.projectRequired'))
      return
    }
    setBusy(true)
    setError(undefined)
    void api.createConnection({ projectId, name, baseUrl, frontendUrl })
      .then(() => {
        setAdding(false)
        resetForm()
        reload()
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusy(false) })
  }

  /**
   * 发起扫描并打开进度弹窗。
   *
   * 后端立刻返回 202，任务在服务端后台跑；弹窗轮询进度，因此**关掉弹窗、刷新页面
   * 都不影响任务**，重开还能看到当前阶段或上次结果。
   */
  const removeConnection = (id: string): void => {
    if (deletingId !== undefined) return
    if (confirmingId !== id) {
      setConfirmingId(id)
      return
    }
    setDeletingId(id)
    setError(undefined)
    void api.deleteConnection(id)
      .then(() => {
        setConfirmingId(undefined)
        reload()
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setDeletingId(undefined) })
  }

  const scan = (id: string): void => {
    setError(undefined)
    setScanning({ connectionId: id, label: rows.find(row => row.id === id)?.name ?? id })
    void api.scanConnection(id)
      .then((receipt) => {
        if (receipt !== undefined) setReceipts(current => ({ ...current, [id]: receipt }))
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
  }

  return (
    <AdminPage
      title={t('panel.connections')}
      desc={t('connections.desc')}
      tabs={{
        items: [
          { key: 'list', label: t('connections.tab.list') },
          { key: 'allowlist', label: t('connections.tab.allowlist') },
        ],
        value: page,
        onChange: setPage,
      }}
      actions={(
        <Button
          variant="primary"
          size="sm"
          icon={<IconPlusOutlineRegular size={14} />}
          onClick={() => { setAdding(current => !current) }}
        >
          {t('connections.add')}
        </Button>
      )}
    >
      {adding && (
        <Card title={t('connections.add')}>
          {/*
           * 每个字段都带标签：这是**四个**不同用途的输入（名称 / 接口根地址 / 认证方式 /
           * 文档地址 / 白名单），只靠 placeholder 会让人把文档地址填进白名单。
           * 白名单排在文档地址之后并明确标注"可选"，避免被当成必填。
           */}
          <form className={css.formStack} onSubmit={submit}>
            <label className={css.fieldLabel} htmlFor="conn-project">{t('connections.form.project')}</label>
            <select
              id="conn-project"
              className={css.select}
              value={projectId ?? ''}
              onChange={(event) => { setProjectId(event.target.value) }}
            >
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <label className={css.fieldLabel} htmlFor="conn-name">{t('connections.form.name')}</label>
            <input
              id="conn-name"
              className={css.input}
              value={name}
              placeholder={t('connections.form.nameHint')}
              onChange={(event) => { setName(event.target.value) }}
            />

            <label className={css.fieldLabel} htmlFor="conn-front">{t('connections.form.frontendUrl')}</label>
            <input
              id="conn-front"
              className={css.input}
              value={frontendUrl}
              placeholder={t('connections.form.frontendUrlHint')}
              onChange={(event) => { setFrontendUrl(event.target.value) }}
            />

            <label className={css.fieldLabel} htmlFor="conn-base">{t('connections.form.baseUrl')}</label>
            <input
              id="conn-base"
              className={css.input}
              value={baseUrl}
              placeholder={t('connections.form.baseUrlHint')}
              onChange={(event) => { setBaseUrl(event.target.value) }}
            />

            <div className={css.row}>
              <Button size="sm" variant="primary" type="submit" disabled={busy || name === '' || baseUrl === '' || frontendUrl === '' || projectId === undefined}>
                {t('connections.form.submit')}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => { setAdding(false); resetForm() }}>
                {t('connections.form.cancel')}
              </Button>
            </div>
          </form>
        </Card>
      )}
      {error !== undefined && <p className={css.formError}>{`${t('common.actionFailed')}${error}`}</p>}
      {page === 'allowlist' && rows.map(row => {
        const pending = row.pendingHosts ?? []
        return (
        <Card key={row.id} title={row.name}>
          {pending.length > 0 && (
            <p className={css.formError}>{t('connections.pendingHosts').replace('{hosts}', pending.join('、'))}</p>
          )}
          <AllowlistEditor t={t} api={api} connectionId={row.id} allowedHosts={row.allowedHosts ?? []} onSaved={reload} />
        </Card>
        )
      })}
      {page === 'list' && rows.map((row) => {
        const receipt = receipts[row.id]
        const pending = row.pendingHosts ?? []
        return (
          <Card
            key={row.id}
            icon={IconApiOutlineRegular}
            title={row.name}
            actions={(
              <>
                <ConnectionHealth status={row.status} t={t} />
                <Button size="sm" variant="outline" icon={<IconRefreshOutlineRegular size={13} />} onClick={() => { scan(row.id) }}>
                  {t('connections.scan')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={deletingId === row.id}
                  onClick={() => { removeConnection(row.id) }}
                >{confirmingId === row.id ? t('common.deleteconfirm') : t('common.delete')}</Button>
              </>
            )}
          >
            <div className={`${css.row} ${css.small} ${css.muted}`}>
              <code>{row.frontendUrl}</code>
              <code>{row.baseUrl}</code>
              <Tag tone={row.type === 'openapi' ? 'read' : 'write'}>{row.type.toUpperCase()}</Tag>
              <span>{t('connections.auth')}{row.auth}</span>
              <span>{t('connections.published').replace('{n}', String(row.tools))}</span>
              <span className={css.spacer} />
              <span>{t('connections.lastCheck')} {row.lastCheck}</span>
            </div>
            {receipt !== undefined && (
              <p className={css.receipt}>
                {t('connections.scanReceipt')
                  .replace('{created}', String(receipt.created.length))
                  .replace('{skipped}', String(receipt.skipped.length))
                  .replace('{total}', String(receipt.total))}
              </p>
            )}
            {receipt === undefined && lastScan[row.id] !== undefined && lastScan[row.id] !== null && (
              // 上次扫描的服务端记录：刷新页面后仍显示，不因重载丢失。
              <p className={css.receipt}>
                {lastScan[row.id]?.phase === 'failed'
                  ? `${t('connections.scanModal.titleFailed')}：${lastScan[row.id]?.reason ?? ''}`
                  : t('connections.scanReceipt')
                    .replace('{created}', String(lastScan[row.id]?.created ?? 0))
                    .replace('{skipped}', String(lastScan[row.id]?.skipped ?? 0))
                    .replace('{total}', String(lastScan[row.id]?.total ?? 0))}
              </p>
            )}
            {pending.length > 0 && (
              <p className={css.formError}>{t('connections.pendingHosts').replace('{hosts}', pending.join('、'))}</p>
            )}
          </Card>
        )
      })}
      {scanning !== undefined && (
        <ScanProgressModal
          t={t}
          api={api}
          connectionId={scanning.connectionId}
          label={scanning.label}
          onClose={() => {
            setScanning(undefined)
            // 关闭只是停止轮询；任务已在服务端跑，回来时重开弹窗即读到结果。
            reload()
          }}
        />
      )}
    </AdminPage>
  )
}

/**
 * 内网白名单编辑器（`.ai-spec/20-security.md` C-4 的授权路径）。
 *
 * 受限出站目标（内网 / 环回 / 链路本地 / 云元数据）默认全禁；这里让平台管理员
 * **按连接**显式授权，而不是由后端写死一个全局开关。当前授权项始终可见——
 * 已放行哪些内网目标必须一眼可见，否则"为什么这个连接能进内网"无从回答。
 */
function AllowlistEditor(props: {
  readonly t: Translate
  readonly api: AgenthubApi
  readonly connectionId: string
  readonly allowedHosts: readonly string[]
  readonly onSaved?: () => void
}): ReactNode {
  const { t, api, connectionId, allowedHosts, onSaved } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState<readonly string[]>(allowedHosts)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const open = (): void => {
    setDraft(saved.join('\n'))
    setError(undefined)
    setEditing(true)
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    // 换行 / 逗号 / 分号都当分隔符：用户不该为填白名单去记格式。
    const next = draft.split(/[\n,;]+/).map(item => item.trim()).filter(item => item !== '')
    void api.setConnectionAllowlist(connectionId, next)
      .then(() => {
        setSaved(next)
        setEditing(false)
        onSaved?.()
      })
      .catch((err: unknown) => { setError(errorMessage(err)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className={css.memRow}>
      <div className={css.row}>
        <span className={css.fieldLabel}>{t('connections.allowlist')}</span>
        <span className={`${css.small} ${css.muted}`}>
          {saved.length === 0
            ? t('connections.allowlistEmpty')
            : saved.map(host => <code key={host} className={css.mono}>{host} </code>)}
        </span>
        <span className={css.spacer} />
        {!editing && (
          <Button size="sm" variant="outline" onClick={open}>{t('connections.allowlistEdit')}</Button>
        )}
      </div>
      {editing && (
        <form className={css.form} onSubmit={submit}>
          <textarea
            className={css.textarea}
            value={draft}
            rows={4}
            aria-label={t('connections.allowlist')}
            placeholder={t('connections.allowlistPlaceholder')}
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy}>
            {t('connections.allowlistSave')}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false) }}>
            {t('connections.allowlistCancel')}
          </Button>
          <p className={`${css.small} ${css.muted}`}>{t('connections.allowlistHint')}</p>
          {error !== undefined && <p className={css.formError}>{`${t('common.actionFailed')}${error}`}</p>}
        </form>
      )}
    </div>
  )
}

/**
 * 扫描进度弹窗。
 *
 * 轮询 `/scan/progress` 而不是等 POST 返回：导入可能跑很久（940 个 operation 且开
 * 风险分级时逐个调模型），同步等待既看不到进度，也没法关掉。状态在服务端，
 * 所以关闭弹窗只是停止轮询，任务照常跑完。
 */
function ScanProgressModal(props: {
  readonly t: Translate
  readonly api: AgenthubApi
  readonly connectionId: string
  readonly label: string
  readonly onClose: () => void
}): ReactNode {
  const { t, api, connectionId, label, onClose } = props
  const [progress, setProgress] = useState<ScanProgressRecord | null>(null)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void api.getScanProgress(connectionId)
        .then((next) => {
          if (!live) return
          setProgress(next)
          // 终止态停止轮询；否则固定间隔继续。
          if (next === null || next.phase === 'done' || next.phase === 'failed') return
          timer = setTimeout(poll, 600)
        })
        .catch(() => {
          if (live) timer = setTimeout(poll, 1200)
        })
    }
    poll()
    return () => { live = false; if (timer !== undefined) clearTimeout(timer) }
  }, [api, connectionId])

  const phase = progress?.phase
  const finished = phase === 'done' || phase === 'failed'
  const title = phase === 'done'
    ? t('connections.scanModal.titleDone')
    : phase === 'failed'
      ? t('connections.scanModal.titleFailed')
      : t('connections.scanModal.title')

  const phaseLabel = (): string => {
    if (progress === null) return t('connections.scanModal.phase.fetching')
    if (progress.phase === 'done' || progress.phase === 'failed') return ''
    return t(`connections.scanModal.phase.${progress.phase}`)
  }

  const counter = progress !== null && progress.total !== null
    ? t('connections.scanModal.progress').replace('{n}', String(progress.processed)).replace('{total}', String(progress.total))
    : progress !== null
      ? t('connections.scanModal.indeterminate').replace('{n}', String(progress.processed))
      : ''

  return (
    <div className={css.modalBackdrop} role="dialog" aria-modal="true" aria-label={title}>
      <div className={css.modalCard}>
        <div className={css.modalTitle}>{`${label} · ${title}`}</div>
        {!finished && (
          <>
            <div className={css.modalPhase}>{phaseLabel()}</div>
            {counter !== '' && <div className={`${css.small} ${css.muted}`}>{counter}</div>}
            {/* 不确定进度用条纹动画：总数未知时不显示百分比，避免编造进度。 */}
            <div className={css.progressTrack}><div className={css.progressIndeterminate} /></div>
            <p className={`${css.small} ${css.muted}`}>{t('connections.scanModal.keepRunning')}</p>
          </>
        )}
        {progress?.phase === 'done' && (
          <p className={css.receipt}>
            {t('connections.scanReceipt')
              .replace('{created}', String(progress.created ?? 0))
              .replace('{skipped}', String(progress.skipped ?? 0))
              .replace('{total}', String(progress.total ?? 0))}
          </p>
        )}
        {progress?.phase === 'failed' && (
          <p className={css.formError}>{`${t('common.actionFailed')}${progress.reason ?? ''}`}</p>
        )}
        <div className={css.row}>
          <span className={css.spacer} />
          <Button size="sm" variant={finished ? 'primary' : 'outline'} onClick={onClose}>
            {t('connections.scanModal.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}

