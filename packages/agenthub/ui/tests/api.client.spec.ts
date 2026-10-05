/**
 * Client memory seam (阶段 C): the five `httpApi` memory methods must hit the
 * routes the server actually registers, carry the CSRF header on writes, and
 * surface U5 error messages instead of swallowing failures.
 *
 * @module tests/api.client.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorMessage, httpApi } from '../src/client/api.ts'

const PROJECT = '55555555-5555-4555-8555-555555555555'
const MEMORY = '77777777-7777-4777-8777-777777777771'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
}

let captured: Captured[] = []

/** Stub global fetch, capturing every request; `body` is returned as parsed JSON. */
function stubFetch(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal('fetch', (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    captured.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    return Promise.resolve({ ok, status, json: async () => body })
  })
}

beforeEach(() => {
  captured = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('httpApi.scanConnection', () => {
  it('202 异步启动 → undefined（不把进度体当 receipt）', async () => {
    stubFetch({ phase: 'fetching', processed: 0, total: null, startedAt: '2026-01-01T00:00:00.000Z' }, true, 202)
    await expect(httpApi.scanConnection('ba3815b1-afd3-4d05-b01b-7c4dd693ca9a')).resolves.toBeUndefined()
  })

  it('200 同步完成 → 返回 receipt', async () => {
    const receipt = { created: ['a'], skipped: [], total: 1 }
    stubFetch(receipt, true, 200)
    await expect(httpApi.scanConnection('ba3815b1-afd3-4d05-b01b-7c4dd693ca9a')).resolves.toEqual(receipt)
  })
})

describe('httpApi 记忆方法（阶段 C 客户端接线）', () => {
  it('listMemories 无 scope → GET 集合路径，解包 items', async () => {
    const rows = [{ id: MEMORY, content: 'x' }]
    stubFetch({ items: rows })
    await expect(httpApi.listMemories(PROJECT)).resolves.toEqual(rows)
    expect(captured[0]?.url).toBe(`/agenthub/api/projects/${PROJECT}/memories`)
    expect(captured[0]?.method).toBe('GET')
  })

  it('listMemories scope=candidate → 带 status 查询参数（候选区数据源）', async () => {
    stubFetch({ items: [] })
    await httpApi.listMemories(PROJECT, 'candidate')
    expect(captured[0]?.url).toBe(`/agenthub/api/projects/${PROJECT}/memories?status=candidate`)
  })

  it('confirmMemory → POST /:mid/confirm 且带 CSRF header', async () => {
    stubFetch({ id: MEMORY, status: 'active' })
    await httpApi.confirmMemory(PROJECT, MEMORY)
    expect(captured[0]?.url).toBe(`/agenthub/api/projects/${PROJECT}/memories/${MEMORY}/confirm`)
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.headers['x-csrf-token']).toBeDefined()
  })

  it('rejectMemory → POST /:mid/reject', async () => {
    stubFetch({ id: MEMORY, rejected: true })
    await httpApi.rejectMemory(PROJECT, MEMORY)
    expect(captured[0]?.url).toContain(`/${MEMORY}/reject`)
    expect(captured[0]?.method).toBe('POST')
  })

  it('setMemoryLocked(true|false) → lock / unlock 两个动作路径', async () => {
    stubFetch({ id: MEMORY, locked: true })
    await httpApi.setMemoryLocked(PROJECT, MEMORY, true)
    expect(captured[0]?.url).toContain(`/${MEMORY}/lock`)

    stubFetch({ id: MEMORY, locked: false })
    await httpApi.setMemoryLocked(PROJECT, MEMORY, false)
    expect(captured[1]?.url).toContain(`/${MEMORY}/unlock`)
  })

  it('deleteMemory 默认软删（无查询参数）、hard=true 时带 hard 参数', async () => {
    stubFetch({ id: MEMORY })
    await httpApi.deleteMemory(PROJECT, MEMORY)
    expect(captured[0]?.method).toBe('DELETE')
    expect(captured[0]?.url).toBe(`/agenthub/api/projects/${PROJECT}/memories/${MEMORY}`)

    stubFetch({ id: MEMORY })
    await httpApi.deleteMemory(PROJECT, MEMORY, true)
    expect(captured[1]?.url).toBe(`/agenthub/api/projects/${PROJECT}/memories/${MEMORY}?hard=true`)
  })

  it('非 2xx → 抛出服务端 message（U5 信封，不静默吞掉）', async () => {
    stubFetch({ code: 'agenthub/rbac/Forbidden', message: '你不是该 Project 的成员', traceId: 't' }, false, 403)
    const error = await httpApi.listMemories(PROJECT).catch((err: unknown) => err)
    expect(errorMessage(error)).toBe('你不是该 Project 的成员')
  })

  it('listProjectSettingsFor 只查该项目的记忆（2 次），不重读其他项目', async () => {
    const OTHER = '66666666-6666-4666-8666-666666666666'
    vi.stubGlobal('fetch', (url: string, init?: { method?: string }) => {
      captured.push({ url, method: init?.method ?? 'GET', headers: {} })
      if (url.endsWith('/projects')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ id: PROJECT, name: 'A' }, { id: OTHER, name: 'B' }],
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) })
    })

    const record = await httpApi.listProjectSettingsFor(PROJECT)
    expect(record.id).toBe(PROJECT)
    const memoryCalls = captured.filter(item => item.url.includes('/memories'))
    // 只命中被重载的那个项目；另一个项目的记忆一次都不查。
    expect(memoryCalls).toHaveLength(2)
    expect(memoryCalls.every(item => item.url.includes(PROJECT))).toBe(true)
    expect(memoryCalls.some(item => item.url.includes(OTHER))).toBe(false)
  })

  it('listProjectSettingsFor 未知项目 → 抛错（不返回伪造记录）', async () => {
    stubFetch({ items: [] })
    const error = await httpApi.listProjectSettingsFor(PROJECT).catch((err: unknown) => err)
    expect(errorMessage(error)).toContain('project not found')
  })
})

describe('httpApi 审计查询（阶段 C3-B 客户端接线）', () => {
  it('listAudit 恒带 projectId（BND-4：没有跨项目查询入口）', async () => {
    stubFetch({ items: [], total: 0 })
    await httpApi.listAudit({ projectId: PROJECT })
    expect(captured[0]?.url).toContain(`projectId=${PROJECT}`)
  })

  it('listAudit 把筛选与分页交给服务端（不在浏览器里筛）', async () => {
    stubFetch({ items: [], total: 0 })
    await httpApi.listAudit({ projectId: PROJECT, status: 'denied', limit: 50, offset: 100 })

    const url = captured[0]?.url ?? ''
    expect(url).toContain('status=denied')
    expect(url).toContain('limit=50')
    expect(url).toContain('offset=100')
  })

  it('listAudit 未给的筛选不出现在查询串里（不发送空值）', async () => {
    stubFetch({ items: [], total: 0 })
    await httpApi.listAudit({ projectId: PROJECT })

    const url = captured[0]?.url ?? ''
    expect(url).not.toContain('status=')
    expect(url).not.toContain('userId=')
    expect(url).not.toContain('offset=')
  })

  it('listAudit 回传 items 与 total（供分页算总页数）', async () => {
    stubFetch({ items: [{ id: 'a-1' }], total: 42 })
    const page = await httpApi.listAudit({ projectId: PROJECT })

    expect(page.total).toBe(42)
    expect(page.items).toHaveLength(1)
  })
})

describe('httpApi 登录闭环', () => {
  it('listBusinessTools 读 /business-tools', async () => {
    stubFetch({ items: ['writeAnything'] })
    await expect(httpApi.listBusinessTools()).resolves.toEqual(['writeAnything'])
    expect(captured[0]?.url).toBe('/agenthub/api/business-tools')
  })

  it('getLoginState 带 tool 与 cwd，响应不当成凭证', async () => {
    stubFetch({ connectionId: 'c1', connectionName: 'ERP', status: 'missing' })
    await expect(httpApi.getLoginState('writeAnything', '/data/p1')).resolves.toEqual({
      connectionId: 'c1',
      connectionName: 'ERP',
      status: 'missing',
    })
    expect(captured[0]?.url).toContain('/agenthub/api/login-state?')
    expect(captured[0]?.url).toContain('tool=writeAnything')
    expect(captured[0]?.url).toContain('cwd=%2Fdata%2Fp1')
  })

  it('startConnectionLogin 走 POST + CSRF', async () => {
    stubFetch({ url: 'http://login.test/enter?ticket=t1' })
    await expect(httpApi.startConnectionLogin('c1')).resolves.toEqual({ url: 'http://login.test/enter?ticket=t1' })
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.url).toBe('/agenthub/api/connections/c1/login')
    expect(captured[0]?.headers['x-csrf-token']).toBeDefined()
  })
})
