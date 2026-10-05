// @vitest-environment jsdom
/**
 * 三个管理页的删除都是两次点击：第一次只改成「确认删除」，第二次才调用接口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgenthubApi, ConnectionHealthRecord, ToolRecord } from '../src/client/api.ts'
import { mockApi } from '../src/client/mock/data.ts'
import { zh, type Translate } from '../src/client/locales.ts'
import { ConnectionsView } from '../src/client/views/ConnectionsView.tsx'
import { ProjectSettingsView } from '../src/client/views/ProjectSettingsView.tsx'
import { ToolsView } from '../src/client/views/ToolsView.tsx'

const t: Translate = key => zh[key]

afterEach(cleanup)

function viewApi(overrides: Partial<AgenthubApi>): AgenthubApi {
  return { ...mockApi, ...overrides }
}

function tool(id: string, usedBy: readonly string[]): ToolRecord {
  return {
    id, name: id, api: id, method: 'GET', path: `/${id}`, source: 'CRM', risk: 'read',
    approval: false, status: 'draft', usedBy, desc: '', params: '{}', result: '',
  }
}

const connection: ConnectionHealthRecord = {
  id: 'c1', name: 'CRM', baseUrl: 'https://crm.example', frontendUrl: 'https://crm.example',
  projectId: 'p1', pendingHosts: [], type: 'openapi', auth: 'session', status: 'healthy',
  tools: 1, lastCheck: '—', allowedHosts: [],
}

describe('管理页删除需要确认', () => {
  it('Tool 中心第二次点击才删除当前项目的这条 Tool', async () => {
    const deleteTool = vi.fn(async () => undefined)
    render(
      <ToolsView
        t={t}
        api={viewApi({
          listTools: async () => [tool('draft-here', ['p1'])],
          listProjectOptions: async () => [{ id: 'p1', name: '销售管理系统' }],
          deleteTool,
        })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(deleteTool).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(deleteTool).toHaveBeenCalledWith('p1', 'draft-here') })
  })

  it('系统连接第二次点击才删除这条连接', async () => {
    const deleteConnection = vi.fn(async () => undefined)
    render(
      <ConnectionsView
        t={t}
        api={viewApi({
          listConnectionHealth: async () => [connection],
          listProjectOptions: async () => [],
          getScanProgress: async () => null,
          deleteConnection,
        })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(deleteConnection).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(deleteConnection).toHaveBeenCalledWith('c1') })
  })

  it('项目设置第二次点击才删除当前项目', async () => {
    const settings = await mockApi.listProjectSettings()
    const target = settings[0]
    if (target === undefined) throw new Error('fixture missing')
    const deleteProject = vi.fn(async () => undefined)
    render(
      <ProjectSettingsView
        t={t}
        api={viewApi({
          listProjectSettings: async () => [target],
          deleteProject,
        })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(deleteProject).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(deleteProject).toHaveBeenCalledWith(target.id) })
  })
})
