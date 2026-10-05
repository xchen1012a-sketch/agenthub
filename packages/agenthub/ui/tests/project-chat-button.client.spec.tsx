// @vitest-environment jsdom
/**
 * 选择项目后进入该项目自己的新会话，不改挂当前这场对话。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { zh, type Translate } from '../src/client/locales.ts'
import { ProjectChatButton } from '../src/client/views/ProjectChatButton.tsx'

const t: Translate = key => zh[key]

afterEach(cleanup)

describe('ProjectChatButton', () => {
  it('点中项目 → 打开该项目的新会话，并回到对话', async () => {
    const startSession = vi.fn()
    const showChat = vi.fn()
    const openProjectSettings = vi.fn()
    const openProjectChat = vi.fn(async () => ({ workspaceId: 'stale', workspacePath: '/data/sales' }))
    const adoptWorkspace = vi.fn(async () => ({ workspaceId: 'ws-live' }))
    render(
      <ProjectChatButton
        wide
        t={t}
        listProjects={() => Promise.resolve([{ id: 'p1', name: '销售管理系统', workspaceId: 'stale' }])}
        openProjectChat={openProjectChat}
        adoptWorkspace={adoptWorkspace}
        startSession={startSession}
        openProjectSettings={openProjectSettings}
        showChat={showChat}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '选择项目' }))
    const item = await screen.findByRole('menuitem', { name: '销售管理系统' })
    fireEvent.click(item)
    await waitFor(() => { expect(startSession).toHaveBeenCalledWith('ws-live') })
    expect(openProjectChat).toHaveBeenCalledWith('p1')
    expect(adoptWorkspace).toHaveBeenCalledWith('/data/sales')
    expect(showChat).toHaveBeenCalledOnce()
    expect(startSession).toHaveBeenCalledWith('ws-live')
    expect(openProjectSettings).not.toHaveBeenCalled()
  })

  it('没有项目 → 只提示去项目设置新建，不开会话', async () => {
    const startSession = vi.fn()
    const openProjectSettings = vi.fn()
    render(
      <ProjectChatButton
        wide
        t={t}
        listProjects={() => Promise.resolve([])}
        openProjectChat={vi.fn()}
        adoptWorkspace={vi.fn()}
        startSession={startSession}
        openProjectSettings={openProjectSettings}
        showChat={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '选择项目' }))
    const link = await screen.findByRole('button', { name: '去项目设置新建' })
    fireEvent.click(link)
    expect(openProjectSettings).toHaveBeenCalledOnce()
    expect(startSession).not.toHaveBeenCalled()
  })
})
