// @vitest-environment jsdom
/**
 * Tool 中心「启用全部」：只提交当前项目，且当前项目没有待启用 Tool 时按钮不可点。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgenthubApi, ToolRecord } from '../src/client/api.ts'
import { mockApi } from '../src/client/mock/data.ts'
import { zh, type Translate } from '../src/client/locales.ts'
import { ToolsView } from '../src/client/views/ToolsView.tsx'

const t: Translate = key => zh[key]

afterEach(cleanup)

function tool(id: string, status: ToolRecord['status'], usedBy: readonly string[]): ToolRecord {
  return {
    id,
    name: id,
    api: id,
    method: 'GET',
    path: `/${id}`,
    source: 'CRM',
    risk: 'read',
    approval: false,
    status,
    usedBy,
    desc: '',
    params: '{}',
    result: '',
  }
}

function viewApi(overrides: Partial<AgenthubApi>): AgenthubApi {
  return { ...mockApi, ...overrides }
}

describe('ToolsView 启用全部', () => {
  it('点击后只启用当前项目里尚未启用的 Tool', async () => {
    const enableAllTools = vi.fn(async () => ({ updated: 1 }))
    render(
      <ToolsView
        t={t}
        api={viewApi({
          listTools: async () => [
            tool('draft-here', 'draft', ['p1']),
            tool('on-here', 'enabled', ['p1']),
            tool('off-there', 'disabled', ['p2']),
          ],
          listProjectOptions: async () => [
            { id: 'p1', name: '销售管理系统' },
            { id: 'p2', name: '库存运营' },
          ],
          enableAllTools,
        })}
      />,
    )
    const button = await screen.findByRole('button', { name: '启用全部' })
    await waitFor(() => { expect((button as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(button)
    await waitFor(() => { expect(enableAllTools).toHaveBeenCalledTimes(1) })
    expect(enableAllTools).toHaveBeenCalledWith('p1')
  })

  it('当前项目的 Tool 都已启用时，按钮不可点', async () => {
    const enableAllTools = vi.fn(async () => ({ updated: 0 }))
    render(
      <ToolsView
        t={t}
        api={viewApi({
          listTools: async () => [tool('on-here', 'enabled', ['p1'])],
          listProjectOptions: async () => [{ id: 'p1', name: '销售管理系统' }],
          enableAllTools,
        })}
      />,
    )
    const button = await screen.findByRole('button', { name: '启用全部' })
    await waitFor(() => { expect((button as HTMLButtonElement).disabled).toBe(true) })
    fireEvent.click(button)
    expect(enableAllTools).not.toHaveBeenCalled()
  })
})
