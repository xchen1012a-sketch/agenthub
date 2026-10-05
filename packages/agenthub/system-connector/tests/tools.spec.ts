/**
 * connector Tool 执行体全分支（P3 方案书阶段 C T6 / §4.3）。
 *
 * 覆盖预期标准 3（无凭证 / 过期阻断 + denied 细分）与 4（上游 403），
 * 以及 api_token / session 两种调用路径、注册过滤条件与 V5 脱敏承诺。
 *
 * @module tests/tools.spec
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  AgenthubError,
  createLogger,
  type ExternalSystemTokenRequiredPayload,
  type LogRecord,
  type Queryable,
  type ToolDeniedPayload,
} from '@agenthub/_shared'
import { CredentialVaultService } from '../../credential-vault/src/index.ts'
import {
  ConnectorToolRegistry,
  LOGIN_REQUIRED_CODE,
  LoginRequiredError,
  parseOperationRef,
  type ConnectorToolRow,
} from '../src/index.ts'
import { FakeDb } from './fakes.ts'
import { MOCK_PASSWORD, MOCK_TOKEN, MOCK_USERNAME, startMockSystem, type MockSystem } from './mock-server.ts'

const USER = '22222222-2222-4222-8222-222222222222'
const PROJECT = '33333333-3333-4333-8333-333333333333'
const CONN = '44444444-4444-4444-8444-444444444444'
const SESSION = 'session-c-1'
/** Base64(32 字节) 测试主密钥（secrets.md §2.1 格式）。 */
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64')

let mock: MockSystem

beforeAll(async () => {
  mock = await startMockSystem()
})

function row(overrides: Partial<ConnectorToolRow> = {}): ConnectorToolRow {
  return {
    id: 'tool-1',
    name: 'writeAnything',
    description: '写入任意内容',
    parameters: { type: 'object', properties: { note: { type: 'string' } } },
    source_ref: 'POST /write-anything',
    connection_id: CONN,
    base_url: mock.baseUrl,
    auth_mode: 'pat',
    allowed_hosts: ['127.0.0.1'],
    ...overrides,
  }
}

interface Harness {
  readonly db: FakeDb
  readonly vault: CredentialVaultService
  readonly registry: ConnectorToolRegistry
  readonly tokenRequired: ExternalSystemTokenRequiredPayload[]
  readonly denied: ToolDeniedPayload[]
  readonly expired: { userId: string; systemConnectionId: string; expiredAt: string }[]
  readonly records: LogRecord[]
}

function harness(binding: { projectId: string; userId: string; sessionId: string } | null = {
  projectId: PROJECT,
  userId: USER,
  sessionId: SESSION,
}, fetchImpl?: typeof fetch): Harness {
  const db = new FakeDb()
  const records: LogRecord[] = []
  const sink = (record: LogRecord): void => {
    records.push(record)
  }
  const tokenRequired: ExternalSystemTokenRequiredPayload[] = []
  const denied: ToolDeniedPayload[] = []
  const expired: { userId: string; systemConnectionId: string; expiredAt: string }[] = []
  const vault = new CredentialVaultService(db as unknown as Queryable, {
    masterKey: MASTER_KEY,
    logger: createLogger('agenthub/credential-vault', { sink }),
    onCredentialExpired: (payload) => {
      expired.push(payload)
    },
  })
  const registry = new ConnectorToolRegistry({
    db: db as unknown as Queryable,
    vault,
    scopes: {
      bindingOf: key => (key === undefined || binding === null ? null : { binding }),
    },
    onTokenRequired: (payload) => {
      tokenRequired.push(payload)
    },
    onDenied: (payload) => {
      denied.push(payload)
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    logger: createLogger('agenthub/system-connector/tools', { sink }),
  })
  return { db, vault, registry, tokenRequired, denied, expired, records }
}

/** 以绑定身份执行 Tool（agent 为 scope key 的引用相等替身）。 */
async function run(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  agent?: object,
): Promise<unknown> {
  const exec = { agent } as unknown as Parameters<typeof definition.execute>[1]
  return definition.execute(args, exec)
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error)
}

function codeOf(error: unknown): string {
  if (error instanceof AgenthubError || error instanceof LoginRequiredError) return error.code
  return 'unexpected-error'
}

/** 记录请求地址与请求头，按给定状态码应答。 */
function recordingFetch(status: number): { fetchImpl: typeof fetch; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    })
    return new Response('{"ok":true}', { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('parseOperationRef（source_ref → HTTP 调用）', () => {
  it('解析 "<METHOD> <path>"；缺失/非法（含小写 method）回退 GET /', () => {
    expect(parseOperationRef('POST /write-anything')).toEqual({ method: 'POST', path: '/write-anything' })
    expect(parseOperationRef('GET /a/b')).toEqual({ method: 'GET', path: '/a/b' })
    expect(parseOperationRef('get /a/b')).toEqual({ method: 'GET', path: '/' })
    expect(parseOperationRef(null)).toEqual({ method: 'GET', path: '/' })
    expect(parseOperationRef('garbage')).toEqual({ method: 'GET', path: '/' })
  })
})

describe('ConnectorToolRegistry · C-1 同源硬边界（凭证不外发）', () => {
  function spyHarness(): { h: Harness; calls: string[] } {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      calls.push(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return { h: harness(undefined, fetchImpl), calls }
  }

  it('绝对 URL path（https://evil/x）→ OriginDenied(403) + denied:origin_mismatch，绝不发请求', async () => {
    const { h, calls } = spyHarness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const error = await catchError(run(h.registry.definition(row({ source_ref: 'GET https://evil.test/x' })), {}, {}))
    expect(codeOf(error)).toBe('agenthub/system-connector/OriginDenied')
    expect((error as AgenthubError).httpStatus).toBe(403)
    expect(h.denied.map(item => item.reason)).toEqual(['denied:origin_mismatch'])
    expect(calls).toEqual([])
  })

  it('协议相对 path（//evil/x）→ OriginDenied(403)，绝不发请求', async () => {
    const { h, calls } = spyHarness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const error = await catchError(run(h.registry.definition(row({ source_ref: 'POST //evil.test/x' })), { note: 'x' }, {}))
    expect(codeOf(error)).toBe('agenthub/system-connector/OriginDenied')
    expect(h.denied.map(item => item.reason)).toEqual(['denied:origin_mismatch'])
    expect(calls).toEqual([])
  })

  it('正常站内 path（/x）→ 同源放行并发出请求', async () => {
    const { h, calls } = spyHarness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const value = await run(h.registry.definition(row({ source_ref: 'GET /anything' })), { q: '1' }, {})
    expect(value).toEqual({})
    expect(calls).toEqual([`${mock.baseUrl}/anything?q=1`])
    expect(h.denied).toHaveLength(0)
  })
})

/** 注册替身：记录注册 / 释放，并维护 live 集合以断言无重复注册 / 泄漏。 */
function registerSpy(): { ctx: Context; registered: string[]; disposed: string[]; live: Set<string> } {
  const registered: string[] = []
  const disposed: string[] = []
  const live = new Set<string>()
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition.name)
        live.add(definition.name)
        return () => {
          live.delete(definition.name)
          disposed.push(definition.name)
        }
      },
    },
  } as unknown as Context
  return { ctx, registered, disposed, live }
}

describe('ConnectorToolRegistry · 注册（T6 / §4.3）', () => {
  it('load 仅注册 enabled=true 且 source=openapi 的行；disposeAll 解除全部注册', async () => {
    const h = harness()
    h.db.connectorTools = [row(), row({ id: 'tool-2', name: 'readAnything', source_ref: 'GET /anything' })]
    h.db.toolEnabled.set('tool-2', false)
    const spy = registerSpy()
    await h.registry.load(spy.ctx)
    expect(spy.registered).toEqual(['writeAnything'])
    const sql = h.db.statements.find(item => item.text.includes('FROM tools t JOIN system_connections c'))?.text ?? ''
    expect(sql).toContain("t.source = 'openapi'")
    expect(sql).toContain('t.enabled = true')
    h.registry.disposeAll()
    expect(spy.disposed).toEqual(['writeAnything'])
    expect(spy.live.size).toBe(0)
  })

  it('重载后启用即生效：load 时 disabled 不注册，置 enabled=true 重新 load → 注册', async () => {
    const h = harness()
    h.db.connectorTools = [row()]
    h.db.toolEnabled.set('tool-1', false)
    const spy = registerSpy()
    await h.registry.load(spy.ctx)
    expect(spy.registered).toEqual([])
    h.db.toolEnabled.set('tool-1', true)
    await h.registry.load(spy.ctx)
    expect(spy.registered).toEqual(['writeAnything'])
    expect(spy.live).toEqual(new Set(['writeAnything']))
  })

  it('重载幂等：连续 load 先释放旧注册再注册，无重复 / 泄漏', async () => {
    const h = harness()
    h.db.connectorTools = [row()]
    const spy = registerSpy()
    await h.registry.load(spy.ctx)
    await h.registry.load(spy.ctx)
    expect(spy.registered).toEqual(['writeAnything', 'writeAnything'])
    expect(spy.disposed).toEqual(['writeAnything'])
    expect(spy.live).toEqual(new Set(['writeAnything']))
  })

  it('C-5 重载窗口守卫：load 后 DB 置 enabled=false → 调用即 denied:tool_disabled，不发请求', async () => {
    const h = harness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    h.db.toolEnabled.set('tool-1', false)
    const error = await catchError(run(h.registry.definition(row()), { note: 'x' }, {}))
    expect(codeOf(error)).toBe('agenthub/system-connector/ToolDisabled')
    expect((error as AgenthubError).httpStatus).toBe(403)
    expect(h.denied.map(item => item.reason)).toEqual(['denied:tool_disabled'])
  })

  it('bindingOf 为 null（无 Session 绑定）→ Unauthenticated(401)，不发任何事件', async () => {
    const h = harness(null)
    const error = await catchError(run(h.registry.definition(row()), { note: 'x' }, undefined))
    expect(codeOf(error)).toBe('agenthub/system-connector/Unauthenticated')
    expect((error as AgenthubError).httpStatus).toBe(401)
    expect(h.tokenRequired).toHaveLength(0)
    expect(h.denied).toHaveLength(0)
  })
})

describe('ConnectorToolRegistry · 凭证阻断分支（预期标准 3）', () => {
  it('无凭证：要求登录（工具结果带登录码）+ external-system.token-required + denied:credential_missing', async () => {
    const h = harness()
    const error = await catchError(run(h.registry.definition(row({ connection_name: 'ERP' })), { note: 'x' }, {}))
    expect(codeOf(error)).toBe(LOGIN_REQUIRED_CODE)
    expect((error as Error).message).toContain('尚未登录「ERP」')
    expect(h.tokenRequired).toEqual([
      { userId: USER, systemConnectionId: CONN, toolId: 'writeAnything', projectId: PROJECT },
    ])
    expect(h.denied).toEqual([
      { toolId: 'writeAnything', projectId: PROJECT, userId: USER, sessionId: SESSION, reason: 'denied:credential_missing' },
    ])
  })

  it('凭证过期：要求重新登录 + credential.expired 事件 + denied:credential_expired（先于解密）', async () => {
    const h = harness()
    await h.vault.storeCredential({
      userId: USER,
      systemConnectionId: CONN,
      plaintext: MOCK_TOKEN,
      expiresAt: new Date('2000-01-01T00:00:00Z'),
    })
    const error = await catchError(run(h.registry.definition(row()), { note: 'x' }, {}))
    expect(codeOf(error)).toBe(LOGIN_REQUIRED_CODE)
    expect((error as Error).message).toContain('登录已失效')
    expect(h.expired).toEqual([
      { userId: USER, systemConnectionId: CONN, expiredAt: '2000-01-01T00:00:00.000Z' },
    ])
    expect(h.tokenRequired).toHaveLength(1)
    expect(h.denied.map(item => item.reason)).toEqual(['denied:credential_expired'])
  })

  it('外部系统 401：凭证记为失效，本次与下次调用都要求重新登录，下次不再发请求', async () => {
    const { fetchImpl, calls } = recordingFetch(401)
    const h = harness(undefined, fetchImpl)
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const first = await catchError(run(h.registry.definition(row()), { note: 'x' }, {}))
    expect(codeOf(first)).toBe(LOGIN_REQUIRED_CODE)
    expect(h.denied.map(item => item.reason)).toEqual(['denied:credential_expired'])
    expect(await h.vault.credentialStatus(USER, CONN)).toBe('expired')

    const second = await catchError(run(h.registry.definition(row()), { note: 'x' }, {}))
    expect(codeOf(second)).toBe(LOGIN_REQUIRED_CODE)
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(h.records) + (first as Error).message).not.toContain(MOCK_TOKEN)
  })

  it('会话过期重授权：重新 storeCredential 后同一 Tool 调用恢复成功', async () => {
    const h = harness()
    const sessionRow = row({ name: 'sessionWrite', source_ref: 'POST /session-write', auth_mode: 'session' })
    await h.vault.storeCredential({
      userId: USER,
      systemConnectionId: CONN,
      plaintext: `sid=${await loginToMock()}`,
      expiresAt: new Date('2000-01-01T00:00:00Z'),
    })
    const blocked = await catchError(run(h.registry.definition(sessionRow), { note: 'x' }, {}))
    expect(codeOf(blocked)).toBe(LOGIN_REQUIRED_CODE)
    // 重授权（模拟反代再次捕获会话）→ 覆盖旧凭证 → 调用恢复。
    const fresh = await loginToMock()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: `sid=${fresh}` })
    const value = await run(h.registry.definition(sessionRow), { note: 'after-reauth' }, {})
    expect(value).toEqual({ ok: true, wrote: { note: 'after-reauth' } })
  })
})

describe('ConnectorToolRegistry · api_token 调用分支（预期标准 4 + V5）', () => {
  it('错误 token：上游 403 → denied:upstream_403 + UpstreamForbidden(403)', async () => {
    const h = harness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: 'wrong-token' })
    const error = await catchError(run(h.registry.definition(row()), { note: 'x' }, {}))
    expect(codeOf(error)).toBe('agenthub/system-connector/UpstreamForbidden')
    expect((error as AgenthubError).httpStatus).toBe(403)
    expect(h.denied.map(item => item.reason)).toEqual(['denied:upstream_403'])
  })

  it('正确 token：上游 200 → 返回 JSON，日志/事件无 token 明文（V5）', async () => {
    const h = harness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const value = await run(h.registry.definition(row()), { note: 'hello' }, {})
    expect(value).toEqual({ ok: true, wrote: { note: 'hello' } })
    expect(h.denied).toHaveLength(0)
    const dumped = JSON.stringify(h.records) + JSON.stringify(h.denied) + JSON.stringify(h.tokenRequired)
    expect(dumped).not.toContain(MOCK_TOKEN)
    const invoke = h.records.find(record => record.event === 'connector.invoke')
    expect(invoke?.data?.status).toBe(200)
  })

  it('GET operation：入参进 query（不进 body）', async () => {
    const h = harness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const getRow = row({ name: 'readAnything', source_ref: 'GET /anything', auth_mode: 'pat' })
    const value = await run(h.registry.definition(getRow), { q: 'needle' }, {})
    expect(value).toEqual({ ok: true, path: '/anything', query: { q: 'needle' } })
  })

  it('凭证按登录时记下的请求头发出；没有记录时按认证方式', async () => {
    const { fetchImpl, calls } = recordingFetch(200)
    const h = harness(undefined, fetchImpl)
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: 'tk-1', carrier: 'x-access-token' })
    await run(h.registry.definition(row()), { note: 'x' }, {})
    expect(calls[0]?.headers['x-access-token']).toBe('tk-1')
    expect(calls[0]?.headers.authorization).toBeUndefined()

    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: 'sid=1' })
    await run(h.registry.definition(row({ auth_mode: 'session' })), { note: 'x' }, {})
    expect(calls[1]?.headers.cookie).toBe('sid=1')
    await run(h.registry.definition(row({ auth_mode: 'pat' })), { note: 'x' }, {})
    expect(calls[2]?.headers.authorization).toBe('sid=1')
  })

  it('上游 5xx：UpstreamError(502)，不发 denied', async () => {
    const h = harness()
    await h.vault.storeCredential({ userId: USER, systemConnectionId: CONN, plaintext: MOCK_TOKEN })
    const missingRow = row({ name: 'ghost', source_ref: 'GET /not-found', base_url: mock.baseUrl })
    const error = await catchError(run(h.registry.definition(missingRow), {}, {}))
    expect(codeOf(error)).toBe('agenthub/system-connector/UpstreamError')
    expect((error as AgenthubError).httpStatus).toBe(502)
    expect(h.denied).toHaveLength(0)
  })
})

/** 经 mock /login 取回会话 cookie 的 `sid` 值（模拟反代捕获的服务端会话）。 */
async function loginToMock(): Promise<string> {
  const response = await fetch(`${mock.baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: MOCK_USERNAME, password: MOCK_PASSWORD }),
  })
  const setCookie = response.headers.getSetCookie()[0] ?? ''
  expect(response.status).toBe(200)
  return setCookie.split(';')[0]?.replace('sid=', '') ?? ''
}
