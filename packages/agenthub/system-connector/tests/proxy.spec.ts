/**
 * 侧边浏览器登录中转与凭证闭环（技术方案《侧边浏览器登录与凭证闭环》§4 / 验收 1–6）。
 *
 * 全链：主站 authorize 签票 → 登录站点 enter 换会话 → 经 `/s/<sid>/*` 登录 mock →
 * 凭证（Cookie 或请求头）连同携带位置加密落库 → connector Tool 按携带位置带回、调用成功。
 * 另覆盖：站点分离、票据一次性、会话失效、外部拒绝不落库、门禁、路径越界与同源守卫。
 *
 * 主站与登录站点共用一个监听端口，只按 Host 区分（与生产部署一致）。
 *
 * @module tests/proxy.spec
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgenthubError, createLogger, type LogRecord, type Queryable, type ToolDeniedPayload } from '@agenthub/_shared'
import { CredentialVaultService } from '../../credential-vault/src/index.ts'
import { ConnectorToolRegistry, LoginDesk, SystemConnectorService, createAuthorizeHandler } from '../src/index.ts'
import { FakeDb } from './fakes.ts'
import { MOCK_PASSWORD, MOCK_TOKEN, MOCK_USERNAME, startMockSystem, type MockSystem } from './mock-server.ts'

const USER = '55555555-5555-4555-8555-555555555555'
const PROJECT = '66666666-6666-4666-8666-666666666666'
const SESSION = 'session-p-1'
const MASTER_KEY = Buffer.alloc(32, 5).toString('base64')
/** 固定时钟（远期，确保凭证未过期；断言 Max-Age=3600 → +1h）。 */
const FIXED_NOW = new Date('2030-01-01T00:00:00Z')

interface Harness {
  readonly mock: MockSystem
  readonly port: number
  readonly mainHost: string
  readonly loginHost: string
  readonly db: FakeDb
  readonly service: SystemConnectorService
  readonly vault: CredentialVaultService
  readonly registry: ConnectorToolRegistry
  readonly denied: ToolDeniedPayload[]
  readonly records: LogRecord[]
  readonly auth: { authenticated: boolean }
}

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

let h: Harness
let proxyServer: Server

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
}

/** 按指定 Host 发请求（fetch 不允许改 Host，这里直接用 node:http）。 */
async function send(
  host: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return await new Promise<Reply>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: h.port, path, method: init.method ?? 'GET', headers: { ...init.headers, host } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

function codeOf(reply: Reply): string {
  return (JSON.parse(reply.body) as { code: string }).code
}

async function createConnection(name: string, authMode: string, member: boolean, openapiDoc?: unknown): Promise<string> {
  const projectId = `77777777-7777-4777-8777-${String(h.db.projects.length + 1).padStart(12, '0')}`
  h.db.projects.push({ id: projectId, system_connection_id: null })
  const connection = await h.service.createConnection({
    userId: USER,
    projectId,
    name,
    baseUrl: h.mock.baseUrl,
    frontendUrl: h.mock.baseUrl,
    authMode,
    allowedHosts: ['127.0.0.1'],
    ...(openapiDoc === undefined ? {} : { openapiDoc }),
  })
  if (member) h.db.projectMembers.push({ connection_id: connection.id, user_id: USER })
  return connection.id
}

/** 主站签票 → 登录站点换会话，返回会话挂载前缀。 */
async function openLoginSession(connectionId: string): Promise<string> {
  const authorize = await send(h.mainHost, `/agenthub/connections/${connectionId}/authorize`)
  expect(authorize.status).toBe(302)
  const entry = new URL(String(authorize.headers.location))
  expect(entry.host).toBe(h.loginHost)
  const enter = await send(h.loginHost, entry.pathname + entry.search)
  expect(enter.status).toBe(302)
  const mount = String(enter.headers.location)
  expect(mount).toMatch(new RegExp(`^/agenthub/connections/${connectionId}/s/[A-Za-z0-9_-]+/$`))
  return mount.slice(0, -1)
}

function storedFor(connectionId: string): FakeDb['credentials'] {
  return h.db.credentials.filter(item => item.user_id === USER && item.system_connection_id === connectionId)
}

beforeAll(async () => {
  const mock = await startMockSystem()
  const db = new FakeDb()
  const records: LogRecord[] = []
  const sink = (record: LogRecord): void => {
    records.push(record)
  }
  const denied: ToolDeniedPayload[] = []
  const vault = new CredentialVaultService(db as unknown as Queryable, {
    masterKey: MASTER_KEY,
    logger: createLogger('agenthub/credential-vault', { sink }),
  })
  const service = new SystemConnectorService(db as unknown as Queryable)
  const registry = new ConnectorToolRegistry({
    db: db as unknown as Queryable,
    vault,
    scopes: {
      bindingOf: key => (key === undefined ? null : { binding: { projectId: PROJECT, userId: USER, sessionId: SESSION } }),
    },
    onTokenRequired: () => {},
    onDenied: (payload) => {
      denied.push(payload)
    },
    logger: createLogger('agenthub/system-connector/tools', { sink }),
  })
  const auth = {
    authenticated: true,
    resolveIdentity: (): Promise<{ userId: string; roles: readonly string[] }> => {
      if (!auth.authenticated) {
        return Promise.reject(new AgenthubError('agenthub/auth/Unauthenticated', '未登录', { httpStatus: 401 }))
      }
      return Promise.resolve({ userId: USER, roles: ['user'] })
    },
  }
  let handler: ReturnType<typeof createAuthorizeHandler> | null = null
  proxyServer = createServer((req, res) => {
    void handler?.(req, res)
  })
  await listen(proxyServer)
  const port = (proxyServer.address() as AddressInfo).port
  const loginHost = `login.test:${String(port)}`
  const desk = new LoginDesk({ origin: `http://${loginHost}` })
  service.configureLogin(desk)
  handler = createAuthorizeHandler({
    service,
    vault,
    auth,
    desk,
    now: () => FIXED_NOW,
    logger: createLogger('agenthub/system-connector/proxy', { sink }),
  })
  h = {
    mock,
    port,
    mainHost: `127.0.0.1:${String(port)}`,
    loginHost,
    db,
    service,
    vault,
    registry,
    denied,
    records,
    auth,
  }
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    proxyServer.close(() => {
      resolve()
    })
  })
  await h.mock.close()
})

function toolRow(connectionId: string, name: string, sourceRef: string, authMode: string): Parameters<ConnectorToolRegistry['definition']>[0] {
  return {
    id: `tool-${name}`,
    name,
    description: name,
    parameters: { type: 'object', properties: { note: { type: 'string' } } },
    source_ref: sourceRef,
    connection_id: connectionId,
    connection_name: 'Mock 外部系统',
    base_url: h.mock.baseUrl,
    auth_mode: authMode,
    allowed_hosts: ['127.0.0.1'],
  }
}

async function runTool(row: Parameters<ConnectorToolRegistry['definition']>[0], note: string): Promise<unknown> {
  const definition = h.registry.definition(row)
  const exec = { agent: {} } as unknown as Parameters<typeof definition.execute>[1]
  return definition.execute({ note }, exec)
}

describe('登录闭环：Cookie 型外部系统', () => {
  let connectionId = ''

  beforeAll(async () => {
    connectionId = await createConnection('Cookie 系统', 'session', true)
  })

  it('签票 → 换会话 → 经中转登录 → Cookie 连同携带位置加密落库 → Tool 带回调用成功', async () => {
    const mount = await openLoginSession(connectionId)
    const login = await send(h.loginHost, `${mount}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://${h.loginHost}` },
      body: JSON.stringify({ username: MOCK_USERNAME, password: MOCK_PASSWORD }),
    })
    expect(login.status).toBe(200)
    // 外部系统的会话只进 vault，不回传浏览器。
    expect(login.headers['set-cookie']).toBeUndefined()

    const stored = storedFor(connectionId)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.carrier).toBe('cookie')
    const resolved = await h.vault.resolveCredential(USER, connectionId)
    expect(resolved.carrier).toBe('cookie')
    expect(resolved.plaintext).toMatch(/^sid=[0-9a-f-]{36}$/)
    // 密文字节与日志里都没有明文（BND-1）。
    expect((stored[0]?.encrypted_payload as Buffer).toString('utf8')).not.toContain(resolved.plaintext)
    expect(JSON.stringify(h.records)).not.toContain(resolved.plaintext)
    expect(JSON.stringify(h.records)).not.toContain(MOCK_PASSWORD)
    // Max-Age=3600 → expires_at = 固定时钟 + 1h。
    expect(new Date(String(stored[0]?.expires_at)).toISOString()).toBe('2030-01-01T01:00:00.000Z')

    await expect(runTool(toolRow(connectionId, 'sessionWrite', 'POST /session-write', 'session'), 'via-login')).resolves.toEqual({
      ok: true,
      wrote: { note: 'via-login' },
    })
    expect(h.denied).toHaveLength(0)
  })

  it('再次登录覆盖旧会话（同员工同连接只有一行）', async () => {
    const before = await h.vault.resolveCredential(USER, connectionId)
    const mount = await openLoginSession(connectionId)
    const login = await send(h.loginHost, `${mount}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: MOCK_USERNAME, password: MOCK_PASSWORD }),
    })
    expect(login.status).toBe(200)
    const after = await h.vault.resolveCredential(USER, connectionId)
    expect(after.plaintext).not.toBe(before.plaintext)
    expect(storedFor(connectionId)).toHaveLength(1)
  })

  it('外部系统拒绝登录（401）→ 不落库', async () => {
    const fresh = await createConnection('拒绝登录', 'session', true)
    const mount = await openLoginSession(fresh)
    const login = await send(h.loginHost, `${mount}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: MOCK_USERNAME, password: 'wrong' }),
    })
    expect(login.status).toBe(401)
    expect(storedFor(fresh)).toHaveLength(0)
  })
})

describe('登录闭环：请求头型外部系统', () => {
  it('前端带授权头访问后端 → 按授权头保存 → Tool 用授权头调用成功', async () => {
    const connectionId = await createConnection('令牌系统', 'pat', true)
    const mount = await openLoginSession(connectionId)
    const reply = await send(h.loginHost, `${mount}/_api/anything?q=1`, { headers: { authorization: MOCK_TOKEN } })
    expect(reply.status).toBe(200)

    const stored = storedFor(connectionId)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.carrier).toBe('authorization')
    expect(stored[0]?.expires_at).toBeNull()
    expect(JSON.stringify(h.records)).not.toContain(MOCK_TOKEN)

    // 同一凭证重复出现不重复写库。
    const writes = h.db.statements.filter(item => item.text.startsWith('INSERT INTO user_credentials')).length
    await send(h.loginHost, `${mount}/_api/anything`, { headers: { authorization: MOCK_TOKEN } })
    expect(h.db.statements.filter(item => item.text.startsWith('INSERT INTO user_credentials')).length).toBe(writes)

    await expect(runTool(toolRow(connectionId, 'writeAnything', 'POST /write-anything', 'pat'), 'via-header')).resolves.toEqual({
      ok: true,
      wrote: { note: 'via-header' },
    })
  })

  it('接口文档声明的自定义凭证头同样截取，并记下头名', async () => {
    const doc = { openapi: '3.0.3', components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Access-Token' } } } }
    const connectionId = await createConnection('自定义头系统', 'pat', true, doc)
    const mount = await openLoginSession(connectionId)
    await send(h.loginHost, `${mount}/_api/anything`, { headers: { 'x-access-token': 'custom-secret-1' } })
    const resolved = await h.vault.resolveCredential(USER, connectionId)
    expect(resolved).toEqual({ plaintext: 'custom-secret-1', carrier: 'x-access-token' })
  })

  it('外部系统自己的租户头原样转发，不在中转丢掉', async () => {
    const connectionId = await createConnection('租户头', 'session', true)
    const mount = await openLoginSession(connectionId)
    const reply = await send(h.loginHost, `${mount}/admin-api/system/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tenant-id': '1', origin: `http://${h.loginHost}` },
      body: '{}',
    })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ tenant: '1' })
  })

  it('文档未声明的请求头不截取', async () => {
    const connectionId = await createConnection('未声明头', 'pat', true)
    const mount = await openLoginSession(connectionId)
    await send(h.loginHost, `${mount}/_api/anything`, { headers: { 'x-unknown-token': 'nope' } })
    expect(storedFor(connectionId)).toHaveLength(0)
  })
})

describe('站点分离 / 票据 / 会话', () => {
  let connectionId = ''

  beforeAll(async () => {
    connectionId = await createConnection('分离检查', 'session', true)
  })

  it('票据只能用一次；换到别的连接无效', async () => {
    const authorize = await send(h.mainHost, `/agenthub/connections/${connectionId}/authorize`)
    const entry = new URL(String(authorize.headers.location))
    const other = await createConnection('另一连接', 'session', true)
    const wrongConnection = await send(h.loginHost, `/agenthub/connections/${other}/enter${entry.search}`)
    expect(wrongConnection.status).toBe(403)
    expect(codeOf(wrongConnection)).toBe('agenthub/system-connector/LoginTicketInvalid')

    const again = await send(h.mainHost, `/agenthub/connections/${connectionId}/authorize`)
    const second = new URL(String(again.headers.location))
    expect((await send(h.loginHost, second.pathname + second.search)).status).toBe(302)
    const reused = await send(h.loginHost, second.pathname + second.search)
    expect(reused.status).toBe(403)
    expect(codeOf(reused)).toBe('agenthub/system-connector/LoginTicketInvalid')
  })

  it('入口与中转只在登录站点；签票只在主站', async () => {
    const mount = await openLoginSession(connectionId)
    expect((await send(h.mainHost, `${mount}/anything`)).status).toBe(404)
    expect((await send(h.mainHost, `/agenthub/connections/${connectionId}/enter?ticket=x`)).status).toBe(404)
    expect((await send(h.loginHost, `/agenthub/connections/${connectionId}/authorize`)).status).toBe(404)
  })

  it('未知或不属于该连接的会话 → 403 LoginSessionInvalid', async () => {
    const unknown = await send(h.loginHost, `/agenthub/connections/${connectionId}/s/not-a-session/anything`)
    expect(unknown.status).toBe(403)
    expect(codeOf(unknown)).toBe('agenthub/system-connector/LoginSessionInvalid')

    const mount = await openLoginSession(connectionId)
    const sid = mount.slice(mount.lastIndexOf('/') + 1)
    const other = await createConnection('第三连接', 'session', true)
    const crossed = await send(h.loginHost, `/agenthub/connections/${other}/s/${sid}/anything`)
    expect(crossed.status).toBe(403)
    expect(codeOf(crossed)).toBe('agenthub/system-connector/LoginSessionInvalid')
  })
})

describe('门禁 / 路径 / 同源', () => {
  let connectionId = ''
  let mount = ''

  beforeAll(async () => {
    connectionId = await createConnection('门禁检查', 'session', true)
    mount = await openLoginSession(connectionId)
  })

  it('未登录平台：签票入口 401', async () => {
    h.auth.authenticated = false
    try {
      const authorize = await send(h.mainHost, `/agenthub/connections/${connectionId}/authorize`)
      expect(authorize.status).toBe(401)
      expect(codeOf(authorize)).toBe('agenthub/auth/Unauthenticated')
    } finally {
      h.auth.authenticated = true
    }
  })

  it('非该连接所属项目成员：签票入口 403 ProxyForbidden', async () => {
    const outsider = await createConnection('外部连接', 'session', false)
    const response = await send(h.mainHost, `/agenthub/connections/${outsider}/authorize`)
    expect(response.status).toBe(403)
    expect(codeOf(response)).toBe('agenthub/system-connector/ProxyForbidden')
  })

  it('编码越界路径（%2F%2F）→ 400 ProxyPathDenied', async () => {
    const response = await send(h.loginHost, `${mount}/%2F%2Fevil.test%2Fx`)
    expect(response.status).toBe(400)
    expect(codeOf(response)).toBe('agenthub/system-connector/ProxyPathDenied')
  })

  it('协议相对路径（//）→ 403 ProxyOriginDenied（不转发无关域）', async () => {
    const response = await send(h.loginHost, `${mount}//evil.test/x`)
    expect(response.status).toBe(403)
    expect(codeOf(response)).toBe('agenthub/system-connector/ProxyOriginDenied')
  })

  it('跨站 Origin 的 POST → 403 ProxyCsrfDenied（不转发、不落库）', async () => {
    const before = h.db.credentials.length
    const response = await send(h.loginHost, `${mount}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ username: MOCK_USERNAME, password: MOCK_PASSWORD }),
    })
    expect(response.status).toBe(403)
    expect(codeOf(response)).toBe('agenthub/system-connector/ProxyCsrfDenied')
    expect(h.db.credentials.length).toBe(before)
  })

  it('平台主站发起的 POST（Origin 为主站）同样拒绝', async () => {
    const response = await send(h.loginHost, `${mount}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://${h.mainHost}` },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })

  it('Sec-Fetch-Site: cross-site → 403', async () => {
    const response = await send(h.loginHost, `${mount}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    expect(response.status).toBe(403)
    expect(codeOf(response)).toBe('agenthub/system-connector/ProxyCsrfDenied')
  })
})
