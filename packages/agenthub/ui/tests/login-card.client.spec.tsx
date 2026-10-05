// @vitest-environment jsdom
/**
 * 对话登录卡片：缺凭证时引导去登录；登录完成后只提示继续，不重放工具调用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LoginState } from '../src/client/api.ts'
import { zh, type Translate } from '../src/client/locales.ts'
import { BusinessToolView } from '../src/client/views/BusinessToolView.tsx'
import { LOGIN_REQUIRED_CODE, LoginCard } from '../src/client/views/LoginCard.tsx'

const t: Translate = key => zh[key]

afterEach(cleanup)

function state(status: LoginState['status']): LoginState {
  return { connectionId: 'conn-1', connectionName: 'ERP', status }
}

describe('LoginCard', () => {
  it('未登录时展示系统名与「去登录」；点击后打开侧边浏览器入口', async () => {
    const openBrowser = vi.fn()
    const startLogin = vi.fn(async () => ({ url: 'http://login.test/enter?ticket=t1' }))
    render(
      <LoginCard
        toolName="writeAnything"
        cwd="/data/p1"
        t={t}
        getLoginState={() => Promise.resolve(state('missing'))}
        startLogin={startLogin}
        openBrowser={openBrowser}
      />,
    )
    expect(await screen.findByRole('button', { name: '去登录' })).toBeTruthy()
    expect(screen.getByText('还没有登录「ERP」，登录后才能调用这个工具。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '去登录' }))
    await waitFor(() => { expect(openBrowser).toHaveBeenCalledWith('http://login.test/enter?ticket=t1') })
    expect(startLogin).toHaveBeenCalledWith('conn-1')
  })

  it('登录完成后变为「已登录，可以让我继续」，不自动重试工具', async () => {
    let current: LoginState = state('expired')
    render(
      <LoginCard
        toolName="writeAnything"
        cwd="/data/p1"
        t={t}
        pollMs={20}
        getLoginState={() => Promise.resolve(current)}
        startLogin={async () => {
          current = state('ready')
          return { url: 'http://login.test/enter?ticket=t2' }
        }}
        openBrowser={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '去登录' }))
    expect(await screen.findByText('已登录「ERP」，可以让我继续。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull()
  })

  it('解析不出系统时不展示去登录，也不出现凭证字样', async () => {
    render(
      <LoginCard
        toolName="writeAnything"
        cwd=""
        t={t}
        getLoginState={() => Promise.reject(new Error('not found'))}
        startLogin={vi.fn()}
        openBrowser={vi.fn()}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('无法确定要登录的系统')
    expect(document.body.textContent).not.toMatch(/token|password|secret/i)
  })
})

describe('BusinessToolView', () => {
  it('工具结果是登录码时渲染登录卡片', async () => {
    render(
      <BusinessToolView
        toolName="writeAnything"
        cwd="/data/p1"
        phase="result"
        block={{ isError: true, error: { code: LOGIN_REQUIRED_CODE } }}
        t={t}
        getLoginState={() => Promise.resolve(state('missing'))}
        startLogin={vi.fn()}
        openBrowser={vi.fn()}
      />,
    )
    expect(await screen.findByRole('button', { name: '去登录' })).toBeTruthy()
  })

  it('其他失败只显示失败行，不出现登录按钮', () => {
    render(
      <BusinessToolView
        toolName="writeAnything"
        phase="result"
        block={{ isError: true, error: { code: 'agenthub/system-connector/UpstreamForbidden' } }}
        t={t}
        getLoginState={vi.fn()}
        startLogin={vi.fn()}
        openBrowser={vi.fn()}
      />,
    )
    expect(screen.getByText('调用失败')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull()
  })
})
