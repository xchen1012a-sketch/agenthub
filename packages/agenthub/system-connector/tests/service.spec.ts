/**
 * system_connections CRUD 与授权路径（P3 方案书阶段 C T6）。
 *
 * @module tests/service.spec
 */
import { describe, expect, it } from 'vitest'
import { AgenthubError, type Queryable } from '@agenthub/_shared'
import { LoginDesk, SystemConnectorService, authorizePath, proxyPath } from '../src/index.ts'
import { FakeDb } from './fakes.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'

function wired(): { db: FakeDb; service: SystemConnectorService } {
  const db = new FakeDb()
  db.projects.push({ id: PROJECT, system_connection_id: null })
  return { db, service: new SystemConnectorService(db as unknown as Queryable) }
}

function openProject(db: FakeDb): string {
  const id = `33333333-3333-4333-8333-${String(db.projects.length).padStart(12, '0')}`
  db.projects.push({ id, system_connection_id: null })
  return id
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error)
}

function codeOf(error: unknown): string {
  return error instanceof AgenthubError ? error.code : 'not-agenthub-error'
}

describe('SystemConnectorService · CRUD（T6 / database-schema §3.3）', () => {
  it('createConnection：归一化 base_url 到 origin，返回视图且 createdBy 来自服务端身份', async () => {
    const { db, service } = wired()
    const created = await service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: '  ERP 测试系统  ',
      baseUrl: 'https://erp.example.com/api?tenant=1',
      frontendUrl: 'https://erp.example.com/login?next=/',
      authMode: 'pat',
    })
    expect(created.name).toBe('ERP 测试系统')
    expect(created.baseUrl).toBe('https://erp.example.com')
    expect(created.frontendUrl).toBe('https://erp.example.com/login')
    expect(created.projectId).toBe(PROJECT)
    expect(created.authMode).toBe('pat')
    expect(created.hasOpenapiDoc).toBe(false)
    expect(created.createdBy).toBe(USER)
    expect(created.createdAt).toBe(created.updatedAt)
    expect(db.connections).toHaveLength(1)
    // 写入语句显式点名 openapi_doc 走 jsonb 转换，无 SELECT *。
    const insert = db.statements.find(item => item.text.startsWith('INSERT INTO system_connections'))
    expect(insert?.text).toContain('::jsonb')
  })

  it('createConnection：携带 openapiDoc（JSONB 落库）→ hasOpenapiDoc=true', async () => {
    const { service } = wired()
    const created = await service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: 'CRM',
      baseUrl: 'http://crm.example.com',
      frontendUrl: 'http://crm.example.com',
      authMode: 'session',
      openapiDoc: { openapi: '3.0.3', paths: {} },
    })
    expect(created.hasOpenapiDoc).toBe(true)
    const fetched = await service.getConnection(created.id)
    expect(fetched.hasOpenapiDoc).toBe(true)
  })

  it('createConnection：name 空 → InvalidConnection(422)；baseUrl 非法 → InvalidBaseUrl(422)；authMode 越界 → InvalidAuthMode(422)', async () => {
    const { service } = wired()
    const emptyName = await catchError(
      service.createConnection({ userId: USER, projectId: PROJECT, name: '   ', baseUrl: 'http://x.test', frontendUrl: 'http://x.test', authMode: 'pat' }),
    )
    expect(codeOf(emptyName)).toBe('agenthub/system-connector/InvalidConnection')
    expect((emptyName as AgenthubError).httpStatus).toBe(422)

    const badUrl = await catchError(
      service.createConnection({ userId: USER, projectId: PROJECT, name: 'x', baseUrl: 'not-a-url', frontendUrl: 'http://x.test', authMode: 'pat' }),
    )
    expect(codeOf(badUrl)).toBe('agenthub/system-connector/InvalidBaseUrl')

    const badScheme = await catchError(
      service.createConnection({ userId: USER, projectId: PROJECT, name: 'x', baseUrl: 'ftp://x.test', frontendUrl: 'http://x.test', authMode: 'pat' }),
    )
    expect(codeOf(badScheme)).toBe('agenthub/system-connector/InvalidBaseUrl')

    const badMode = await catchError(
      service.createConnection({ userId: USER, projectId: PROJECT, name: 'x', baseUrl: 'http://x.test', frontendUrl: 'http://x.test', authMode: 'basic' }),
    )
    expect(codeOf(badMode)).toBe('agenthub/system-connector/InvalidAuthMode')
  })

  it('getConnection：不存在 → ConnectionNotFound(404)', async () => {
    const { service } = wired()
    const error = await catchError(service.getConnection('missing-id'))
    expect(codeOf(error)).toBe('agenthub/system-connector/ConnectionNotFound')
    expect((error as AgenthubError).httpStatus).toBe(404)
  })

  it('updateConnection：局部更新；空补丁返回现状；不存在 → 404', async () => {
    const { service } = wired()
    const created = await service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: '旧名',
      baseUrl: 'http://old.test',
      frontendUrl: 'http://old.test',
      authMode: 'pat',
      openapiUrl: 'http://old.test/openapi.json',
    })
    const renamed = await service.updateConnection(created.id, { name: '新名' })
    expect(renamed.name).toBe('新名')
    expect(renamed.baseUrl).toBe('http://old.test')
    expect(renamed.openapiUrl).toBe('http://old.test/openapi.json')

    const rebound = await service.updateConnection(created.id, {
      baseUrl: 'https://new.test/path',
      openapiDoc: { openapi: '3.0.3', paths: {} },
    })
    expect(rebound.baseUrl).toBe('https://new.test')
    expect(rebound.hasOpenapiDoc).toBe(true)
    expect(rebound.authMode).toBe('session')

    const untouched = await service.updateConnection(created.id, {})
    expect(untouched.name).toBe('新名')

    const missing = await catchError(service.updateConnection('missing-id', { name: 'x' }))
    expect(codeOf(missing)).toBe('agenthub/system-connector/ConnectionNotFound')
  })

  it('内网地址可以先保存；未放行时登录/解析/调用被拒绝，放入白名单后恢复', async () => {
    const { service } = wired()
    const created = await service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: '内网',
      baseUrl: 'http://10.1.2.3',
      frontendUrl: 'http://10.1.2.3/login',
    })
    expect(created.pendingHosts).toEqual(['10.1.2.3'])
    expect(created.authMode).toBe('session')
    const blocked = await catchError(Promise.resolve().then(() => { service.assertOperationsAllowed(created) }))
    expect(codeOf(blocked)).toBe('agenthub/system-connector/NotAllowlisted')

    const released = await service.updateConnection(created.id, { allowedHosts: ['10.1.2.3'] })
    expect(released.pendingHosts).toEqual([])
    expect(() => { service.assertOperationsAllowed(released) }).not.toThrow()
  })

  it('非法文档地址仍在保存时拒绝；一个项目不能接第二条连接', async () => {
    const { db, service } = wired()
    const badScheme = await catchError(service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: 'x',
      baseUrl: 'http://x.test',
      frontendUrl: 'http://x.test',
      openapiUrl: 'ftp://x.test/openapi.json',
    }))
    expect(codeOf(badScheme)).toBe('agenthub/system-connector/InvalidOpenApiUrl')

    await service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: 'first',
      baseUrl: 'http://x.test',
      frontendUrl: 'http://x.test',
    })
    const second = await catchError(service.createConnection({
      userId: USER,
      projectId: PROJECT,
      name: 'second',
      baseUrl: 'http://y.test',
      frontendUrl: 'http://y.test',
    }))
    expect(codeOf(second)).toBe('agenthub/system-connector/ProjectAlreadyConnected')
    const missing = await catchError(service.createConnection({
      userId: USER,
      projectId: '99999999-9999-4999-8999-999999999999',
      name: 'gone',
      baseUrl: 'http://z.test',
      frontendUrl: 'http://z.test',
    }))
    expect(codeOf(missing)).toBe('agenthub/system-connector/ProjectNotFound')
    expect(db.connections).toHaveLength(1)
  })

  it('listConnections：按 created_at DESC 返回（视图字段完整）', async () => {
    const { db, service } = wired()
    const first = await service.createConnection({
      userId: USER, projectId: PROJECT, name: 'A', baseUrl: 'http://a.test', frontendUrl: 'http://a.test', authMode: 'pat',
    })
    const other = openProject(db)
    await service.createConnection({
      userId: USER, projectId: other, name: 'B', baseUrl: 'http://b.test', frontendUrl: 'http://b.test', authMode: 'oidc',
    })
    const list = await service.listConnections()
    expect(list.map(item => item.name)).toEqual(['B', 'A'])
    expect(list[1]?.id).toBe(first.id)
    expect(list.every(item => ! item.hasOpenapiDoc)).toBe(true)
  })

  it('deleteConnection：首次 true、再次 false', async () => {
    const { service } = wired()
    const created = await service.createConnection({
      userId: USER, projectId: PROJECT, name: 'X', baseUrl: 'http://x.test', frontendUrl: 'http://x.test', authMode: 'pat',
    })
    await expect(service.deleteConnection(created.id)).resolves.toBe(true)
    await expect(service.deleteConnection(created.id)).resolves.toBe(false)
    await expect(service.listConnections()).resolves.toEqual([])
  })
})

describe('SystemConnectorService · C-5 运行期重载（T6 / §4.3）', () => {
  it('未装配重载器 → reloadTools no-op；setToolReloader 后委托调用', async () => {
    const { service } = wired()
    await expect(service.reloadTools()).resolves.toBeUndefined()
    let calls = 0
    service.setToolReloader(async () => {
      calls += 1
    })
    await service.reloadTools()
    expect(calls).toBe(1)
  })
})

describe('SystemConnectorService · 侧边浏览器登录入口', () => {
  async function connected(): Promise<{ db: FakeDb; service: SystemConnectorService; connectionId: string }> {
    const { db, service } = wired()
    const created = await service.createConnection({
      userId: USER, projectId: PROJECT, name: 'ERP', baseUrl: 'http://erp.test', frontendUrl: 'http://erp.test/login',
      authMode: 'pat', allowedHosts: ['erp.test'],
    })
    return { db, service, connectionId: created.id }
  }

  it('未配置登录站点 → LoginOriginMissing(503)', async () => {
    const { service, connectionId } = await connected()
    const error = await catchError(service.startLogin(USER, ['user'], connectionId))
    expect(codeOf(error)).toBe('agenthub/system-connector/LoginOriginMissing')
    expect((error as AgenthubError).httpStatus).toBe(503)
    expect(service.loginHost()).toBeNull()
  })

  it('项目成员 → 登录站点上的一次性入口；非成员 → ProxyForbidden(403)，不签票据', async () => {
    const { db, service, connectionId } = await connected()
    service.configureLogin(new LoginDesk({ origin: 'http://login.test:5080', token: () => 'ticket-1' }))
    expect(service.loginHost()).toBe('login.test:5080')

    const denied = await catchError(service.startLogin(USER, ['user'], connectionId))
    expect(codeOf(denied)).toBe('agenthub/system-connector/ProxyForbidden')

    db.projectMembers.push({ connection_id: connectionId, user_id: USER })
    const entry = await service.startLogin(USER, ['user'], connectionId)
    expect(entry).toBe(`http://login.test:5080/agenthub/connections/${connectionId}/enter?ticket=ticket-1`)
  })

  it('不限认证方式：令牌类连接同样可以登录', async () => {
    const { db, service, connectionId } = await connected()
    service.configureLogin(new LoginDesk({ origin: 'http://login.test:5080' }))
    db.projectMembers.push({ connection_id: connectionId, user_id: USER })
    await expect(service.startLogin(USER, ['user'], connectionId)).resolves.toMatch(/\/enter\?ticket=/)
  })

  it('authorizePath / proxyPath 路径约定', () => {
    expect(authorizePath('c9')).toBe('/agenthub/connections/c9/authorize')
    expect(proxyPath('c9', 'sid-1')).toBe('/agenthub/connections/c9/s/sid-1')
  })
})

describe('LoginDesk · 票据与中转会话', () => {
  function desk(clock: { now: number }): LoginDesk {
    let seq = 0
    return new LoginDesk({
      origin: 'http://login.test:5080',
      now: () => clock.now,
      token: () => {
        seq += 1
        return `t${String(seq)}`
      },
    })
  }

  it('票据只能用一次，且只对签发时的连接有效', () => {
    const clock = { now: 0 }
    const d = desk(clock)
    d.issue(USER, 'conn-a')
    expect(d.enter('t1', 'conn-b')).toBeNull()
    d.issue(USER, 'conn-a')
    const session = d.enter('t2', 'conn-a')
    expect(session?.userId).toBe(USER)
    expect(d.enter('t2', 'conn-a')).toBeNull()
  })

  it('票据 2 分钟过期；会话 30 分钟空闲过期且每次访问顺延', () => {
    const clock = { now: 0 }
    const d = desk(clock)
    d.issue(USER, 'conn-a')
    clock.now = 2 * 60 * 1000
    expect(d.enter('t1', 'conn-a')).toBeNull()

    d.issue(USER, 'conn-a')
    const session = d.enter('t2', 'conn-a')
    const id = session?.id ?? ''
    clock.now += 29 * 60 * 1000
    expect(d.session(id, 'conn-a')).not.toBeNull()
    clock.now += 29 * 60 * 1000
    expect(d.session(id, 'conn-a')).not.toBeNull()
    expect(d.session(id, 'conn-b')).toBeNull()
    clock.now += 30 * 60 * 1000
    expect(d.session(id, 'conn-a')).toBeNull()
  })

  it('按 Host 识别登录站点；非法源配置启动即报错', () => {
    const d = desk({ now: 0 })
    expect(d.isLoginHost('login.test:5080')).toBe(true)
    expect(d.isLoginHost('LOGIN.test:5080')).toBe(true)
    expect(d.isLoginHost('127.0.0.1:5080')).toBe(false)
    expect(d.isLoginHost(undefined)).toBe(false)
    expect(() => new LoginDesk({ origin: 'not a url' })).toThrow(AgenthubError)
    expect(() => new LoginDesk({ origin: 'ftp://login.test' })).toThrow(AgenthubError)
  })
})

