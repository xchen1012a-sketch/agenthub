/**
 * 对话里的登录卡片：只带连接与工具名，不含凭证。
 * 点「去登录」在侧边浏览器打开中转入口；登录完成后提示员工让 agent 继续。
 * 上游没有公开的「重放这次工具调用」接口，所以这里不自动重试。
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { LoginState } from '../api.ts'
import type { Translate } from '../locales.ts'
import css from './LoginCard.module.css'

/** 工具结果里的登录错误码，须与 @agenthub/system-connector 的 LOGIN_REQUIRED_CODE 一致。 */
export const LOGIN_REQUIRED_CODE = 'AGENTHUB_LOGIN_REQUIRED'

const DEFAULT_POLL_MS = 2000

export interface LoginCardProps {
  readonly toolName: string
  readonly cwd: string
  readonly t: Translate
  readonly getLoginState: (tool: string, cwd: string) => Promise<LoginState>
  readonly startLogin: (connectionId: string) => Promise<{ url: string }>
  readonly openBrowser: (url: string) => void
  readonly pollMs?: number
}

function fill(template: string, name: string): string {
  return template.replaceAll('{name}', name)
}

/**
 * 展示系统名、登录状态和「去登录」。登录完成后不重放工具调用。
 * @param props - 工具名、会话工作目录、文案与登录动作。
 */
export function LoginCard(props: LoginCardProps): ReactNode {
  const { toolName, cwd, t, getLoginState, startLogin, openBrowser } = props
  const pollMs = props.pollMs ?? DEFAULT_POLL_MS
  const [state, setState] = useState<LoginState | null>(null)
  const [phase, setPhase] = useState<'loading' | 'idle' | 'opening' | 'failed'>('loading')

  useEffect(() => {
    let cancelled = false
    void getLoginState(toolName, cwd).then(
      (next) => {
        if (!cancelled) {
          setState(next)
          setPhase('idle')
        }
      },
      () => {
        if (!cancelled) setPhase('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [toolName, cwd, getLoginState])

  useEffect(() => {
    if (state === null || state.status === 'ready' || phase !== 'opening') return undefined
    const timer = setInterval(() => {
      void getLoginState(toolName, cwd).then(
        (next) => { setState(next) },
        () => { /* 轮询失败保持当前状态，下一次再试 */ },
      )
    }, pollMs)
    return () => {
      clearInterval(timer)
    }
  }, [state, phase, toolName, cwd, getLoginState, pollMs])

  const name = state?.connectionName ?? toolName
  const go = (): void => {
    if (state === null) return
    setPhase('opening')
    void startLogin(state.connectionId).then(
      (opened) => { openBrowser(opened.url) },
      () => { setPhase('failed') },
    )
  }

  if (phase === 'loading') {
    return (
      <section className={css.card} aria-busy="true">
        <p className={css.note}>{t('login.card.opening')}</p>
      </section>
    )
  }
  if (state === null) {
    return (
      <section className={css.card} role="alert">
        <p className={css.note}>{t('login.card.unknown')}</p>
      </section>
    )
  }
  if (state.status === 'ready') {
    return (
      <section className={css.card}>
        <p className={css.title}>{fill(t('login.card.title'), name)}</p>
        <p className={css.note}>{fill(t('login.card.ready'), name)}</p>
      </section>
    )
  }

  const body = state.status === 'expired'
    ? fill(t('login.card.expired'), name)
    : fill(t('login.card.missing'), name)
  return (
    <section className={css.card}>
      <p className={css.title}>{fill(t('login.card.title'), name)}</p>
      <p className={css.note}>{body}</p>
      <p className={css.note}>{t('login.card.continue')}</p>
      {phase === 'failed' ? <p className={css.note} role="alert">{t('login.card.failed')}</p> : null}
      <button type="button" className={css.action} disabled={phase === 'opening'} onClick={go}>
        {phase === 'opening' ? t('login.card.opening') : t('login.card.go')}
      </button>
    </section>
  )
}
