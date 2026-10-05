/**
 * Badge helpers shared by the console pages, in the prototype's chip language:
 * risk tags (.tag-read/.tag-write/.tag-critical) and status dots
 * (.dot-ok/.dot-warn/.dot-err/.dot-off) on the admin token set. Label
 * copy resolves through the `agenthub` locale namespace.
 */

import type { ReactNode } from 'react'
import css from '../ui/admin.module.css'
import type {
  ApprovalStatus, BadcaseCause, BadcaseStatus, ConnectionStatus, ToolRisk, ToolStatus,
} from '../api.ts'
import type { Translate } from '../locales.ts'

/** Status semantic shared by every dot: ok / warn / err / off. */
type DotKind = 'ok' | 'warn' | 'err' | 'off'

/** CSS module 键访问在 noUncheckedIndexedAccess 下可缺省；className 接受 undefined。 */
const DOT_CLASS: Record<DotKind, string | undefined> = {
  ok: css.dotOk,
  warn: css.dotWarn,
  err: css.dotErr,
  off: css.dotOff,
}

/** Render a prototype status chip: colored dot + localized text. */
function StatusChip({ kind, label }: { kind: DotKind; label: string }): ReactNode {
  return (
    <span className={css.statusTag}>
      <span className={DOT_CLASS[kind]} />
      {label}
    </span>
  )
}

/** Render a risk chip: READ green / WRITE amber / SENSITIVE amber-strong / CRITICAL red (codes stay untranslated). */
export function RiskTag({ risk }: { risk: ToolRisk }): ReactNode {
  const cls = risk === 'critical' ? css.tagCritical
    : risk === 'write' ? css.tagWrite
      : risk === 'sensitive' ? css.tagSensitive
        : css.tagRead
  return <span className={`${css.tag} ${cls}`}>{risk.toUpperCase()}</span>
}

/** Render a tool lifecycle chip. */
export function ToolStatusTag({ status, t }: { status: ToolStatus; t: Translate }): ReactNode {
  const kind: DotKind = status === 'enabled' ? 'ok' : status === 'draft' ? 'warn' : 'off'
  return <StatusChip kind={kind} label={t(`status.tool.${status}`)} />
}

/** Render an approval decision chip. */
export function ApprovalStatusTag({ status, t }: { status: ApprovalStatus; t: Translate }): ReactNode {
  const kind: DotKind = status === 'approved' ? 'ok' : status === 'rejected' ? 'err' : status === 'expired' ? 'off' : 'warn'
  return <StatusChip kind={kind} label={t(`status.approval.${status}`)} />
}

/** Render a badcase triage chip. */
export function BadcaseStatusTag({ status, t }: { status: BadcaseStatus; t: Translate }): ReactNode {
  const kind: DotKind = status === 'resolved' ? 'ok' : 'warn'
  return <StatusChip kind={kind} label={t(`status.badcase.${status}`)} />
}

/** Render a connection health chip. */
export function ConnectionHealth({ status, t }: { status: ConnectionStatus; t: Translate }): ReactNode {
  const kind: DotKind = status === 'healthy' ? 'ok' : 'warn'
  return <StatusChip kind={kind} label={t(`status.connection.${status}`)} />
}

/** Render a badcase cause as plain localized text (the prototype shows no chip here). */
export function CauseText({ cause, t }: { cause: BadcaseCause; t: Translate }): ReactNode {
  return <span>{t(`cause.${cause}`)}</span>
}
