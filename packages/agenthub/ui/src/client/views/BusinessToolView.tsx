/**
 * 业务工具在对话里的一行。需要登录时换成登录卡片；其余只显示工具名与阶段。
 * 不复用上游通用卡片（未公开导出）。
 */

import { createElement, type ReactNode } from 'react'
import type { LoginState } from '../api.ts'
import type { Translate } from '../locales.ts'
import { LOGIN_REQUIRED_CODE, LoginCard } from './LoginCard.tsx'
import css from './LoginCard.module.css'

export interface BusinessToolViewProps {
  readonly toolName: string
  readonly cwd?: string
  readonly phase: 'preparing' | 'start' | 'result'
  readonly block?: { readonly isError?: boolean; readonly error?: { readonly code?: string } }
  readonly t: Translate
  readonly getLoginState: (tool: string, cwd: string) => Promise<LoginState>
  readonly startLogin: (connectionId: string) => Promise<{ url: string }>
  readonly openBrowser: (url: string) => void
}

function phaseKey(phase: BusinessToolViewProps['phase'], failed: boolean): 'tool.row.preparing' | 'tool.row.running' | 'tool.row.done' | 'tool.row.failed' {
  if (phase === 'preparing') return 'tool.row.preparing'
  if (phase === 'start') return 'tool.row.running'
  return failed ? 'tool.row.failed' : 'tool.row.done'
}

/**
 * 业务工具行。登录需求只看工具结果上的错误码，不读任何凭证。
 * @param props - 工具调用阶段、文案与登录动作。
 */
export function BusinessToolView(props: BusinessToolViewProps): ReactNode {
  const failed = props.phase === 'result' && props.block?.isError === true
  const loginRequired = failed && props.block?.error?.code === LOGIN_REQUIRED_CODE
  if (loginRequired) {
    return createElement(LoginCard, {
      toolName: props.toolName,
      cwd: props.cwd ?? '',
      t: props.t,
      getLoginState: props.getLoginState,
      startLogin: props.startLogin,
      openBrowser: props.openBrowser,
    })
  }
  return (
    <div className={css.row}>
      <span className={css.name}>{props.toolName}</span>
      <span className={css.phase}>{props.t(phaseKey(props.phase, failed))}</span>
    </div>
  )
}
