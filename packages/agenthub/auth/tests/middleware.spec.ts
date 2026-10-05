import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { getTraceId, type LogRecord } from '@agenthub/_shared'
import {
  CSRF_COOKIE,
  DEV_USER_ID,
  SESSION_COOKIE,
  AuthService,
  withIdentity,
} from '../src/index.ts'

const SECRET = 'unit-test-cookie-secret-0123456789abcdef'

interface FakeResponse {
  statusCode: number
  headersSent: boolean
  headers: Map<string, string | string[]>
  body: string
  setHeader(key: string, value: string | string[]): void
  getHeader(key: string): string | string[] | undefined
  end(body?: string): void
  destroy(): void
}

function fakeReq(
  headers: Record<string, string> = {},
  bodyChunks?: string[],
  method: string = bodyChunks === undefined ? 'GET' : 'POST',
): IncomingMessage {
  const chunks = bodyChunks?.map(chunk => Buffer.from(chunk)) ?? []
  return {
    headers,
    url: '/agenthub/projects',
    method,
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  } as unknown as IncomingMessage
}

function fakeRes(): FakeResponse {
  return {
    headersSent: false,
    statusCode: 200,
    headers: new Map<string, string | string[]>(),
    body: '',
    setHeader(key: string, value: string | string[]) {
      this.headers.set(key, value)
    },
    getHeader(key: string) {
      return this.headers.get(key)
    },
    end(body?: string) {
      this.body = body ?? ''
      // 模拟 Node ServerResponse：响应体写出后 headersSent 置真，此后无法再补 header。
      this.headersSent = true
    },
    destroy() {},
  }
}

function testLogger(records: LogRecord[] = []) {
  return {
    package: 'agenthub/auth-test',
    debug: () => {},
    info: (input: { event: string; projectId: string | null; userId: string | null; traceId: string | null; sessionId: string | null }) =>
      records.push({
        level: 'info',
        ts: 'test',
        event: input.event,
        project_id: input.projectId,
        user_id: input.userId,
        trace_id: input.traceId,
        session_id: input.sessionId,
        package: 'agenthub/auth-test',
      }),
    warn: () => {},
    error: () => {},
  }
}

function devAuth() {
  return new AuthService({
    db: { query: async () => ({ rows: [] }) },
    logger: testLogger(),
  })
}

describe('withIdentity（OBS-1 / U5 / .ai-spec 20-security.md SEC-5）', () => {
  it('合法 x-trace-id 透传给 handler；响应回写同值 header；dev 身份注入', async () => {
    const context = new Context()
    const auth = devAuth()
    const records: LogRecord[] = []
    const handler = withIdentity(context, auth, (_req, res, identity) => {
      expect(identity.traceId).toBe('0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f')
      expect(getTraceId(identity.requestContext)).toBe(identity.traceId)
      expect(identity.user.userId).toBe(DEV_USER_ID)
      res.setHeader('x-note', 'ok')
      res.end()
    }, testLogger(records))
    const res = fakeRes()
    await handler(fakeReq({ 'x-trace-id': '0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f' }), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(200)
    expect(res.headers.get('x-trace-id')).toBe('0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'request.completed',
      trace_id: '0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
      user_id: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('缺失 header 时 handler 收到新 UUIDv4 traceId（OBS-1 兜底）', async () => {
    const context = new Context()
    let seen = ''
    const handler = withIdentity(context, devAuth(), (_req, _res, identity) => {
      seen = identity.traceId
    })
    await handler(fakeReq(), fakeRes() as unknown as ServerResponse)
    expect(seen).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('真登录模式无 Cookie → 401 envelope（code Unauthenticated）', async () => {
    const context = new Context()
    const auth = new AuthService({
      db: { query: async () => ({ rows: [] }) },
      env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: SECRET },
      logger: testLogger(),
    })
    const handler = withIdentity(context, auth, () => {})
    const res = fakeRes()
    await handler(fakeReq(), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(401)
    const envelope = JSON.parse(res.body) as { code: string; traceId: string }
    expect(envelope.code).toBe('agenthub/auth/Unauthenticated')
    expect(envelope.traceId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('handler 抛未知错误 → fail-closed 通用 envelope（code 固定 UnknownError）', async () => {
    const context = new Context()
    const handler = withIdentity(context, devAuth(), () => {
      throw new Error('secret internal detail')
    })
    const res = fakeRes()
    await handler(fakeReq(), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(500)
    const envelope = JSON.parse(res.body) as { code: string; message: string }
    expect(envelope.code).toBe('agenthub/_shared/UnknownError')
    expect(envelope.message).not.toContain('secret')
  })

  it('写请求缺 CSRF 令牌 → 403 CsrfRejected', async () => {
    const context = new Context()
    let reached = false
    const handler = withIdentity(context, devAuth(), () => {
      reached = true
    })
    const res = fakeRes()
    await handler(fakeReq({}, ['name=平台组']), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(403)
    const payload = JSON.parse(res.body) as { code: string }
    expect(payload.code).toBe('agenthub/auth/CsrfRejected')
    expect(reached).toBe(false)
  })

  it('写请求带匹配 CSRF（header 或表单 _csrf）→ 放行；表单体传给 handler', async () => {
    const context = new Context()
    const auth = devAuth()
    const token = 'csrf-token-0123456789abcdef0123456789abcdef'
    const seenForms: string[] = []
    const handler = withIdentity(context, auth, (_req, _res, identity) => {
      seenForms.push(identity.form?.get('name') ?? '')
      void identity
    })
    // header 通道
    const viaHeader = fakeRes()
    await handler(
      fakeReq({ cookie: `${CSRF_COOKIE}=${token}`, 'x-csrf-token': token }, ['name=甲']),
      viaHeader as unknown as ServerResponse,
    )
    expect(viaHeader.statusCode).toBe(200)
    // 表单通道
    const viaForm = fakeRes()
    await handler(
      fakeReq({ cookie: `${CSRF_COOKIE}=${token}` }, [`_csrf=${token}&name=乙`]),
      viaForm as unknown as ServerResponse,
    )
    expect(viaForm.statusCode).toBe(200)
    expect(seenForms).toEqual(['甲', '乙'])
  })

  it('PUT 表单体同样解析并传给 handler（连接白名单等 API）', async () => {
    const context = new Context()
    const token = 'csrf-token-0123456789abcdef0123456789abcdef'
    let allowedHosts = ''
    const handler = withIdentity(context, devAuth(), (_req, _res, identity) => {
      allowedHosts = identity.form?.get('allowedHosts') ?? ''
    })
    const res = fakeRes()
    await handler(
      fakeReq(
        { cookie: `${CSRF_COOKIE}=${token}`, 'x-csrf-token': token },
        ['allowedHosts=localhost'],
        'PUT',
      ),
      res as unknown as ServerResponse,
    )
    expect(res.statusCode).toBe(200)
    expect(allowedHosts).toBe('localhost')
  })

  it('无 CSRF Cookie 的请求补签双提交 Cookie；handler 追加的会话 Cookie 不被覆盖', async () => {
    const context = new Context()
    const handler = withIdentity(context, devAuth(), (_req, res) => {
      // 模拟路由层下发会话 Cookie（登录场景）——必须追加，覆盖会丢掉 CSRF Cookie。
      const existing = res.getHeader('set-cookie')
      const previous = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]
      res.setHeader('set-cookie', [...previous, `${SESSION_COOKIE}=abc.def; Path=/`])
      res.end()
    })
    const res = fakeRes()
    await handler(fakeReq(), res as unknown as ServerResponse)
    const cookies = res.headers.get('set-cookie')
    expect(Array.isArray(cookies)).toBe(true)
    const list = cookies as string[]
    expect(list.some(value => value.startsWith(`${SESSION_COOKIE}=`))).toBe(true)
    expect(list.some(value => value.startsWith('agenthub_csrf='))).toBe(true)
  })

  it('已有 CSRF Cookie 时不重复补签', async () => {
    const context = new Context()
    const handler = withIdentity(context, devAuth(), () => {})
    const res = fakeRes()
    await handler(fakeReq({ cookie: `${CSRF_COOKIE}=stable-token` }), res as unknown as ServerResponse)
    expect(res.headers.get('set-cookie')).toBeUndefined()
  })

  it('并发请求各自持有隔离 Cordis traceId，结束后 provider 被释放', async () => {
    const context = new Context()
    const auth = devAuth()
    const requestContexts: Context[] = []
    let arrivals = 0
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = withIdentity(context, auth, async (_req, _res, identity) => {
      requestContexts.push(identity.requestContext)
      arrivals += 1
      if (arrivals === 2) release?.()
      await barrier
      expect(getTraceId(identity.requestContext)).toBe(identity.traceId)
    })

    await Promise.all([
      handler(
        fakeReq({ 'x-trace-id': '10000000-0000-4000-8000-000000000001' }),
        fakeRes() as unknown as ServerResponse,
      ),
      handler(
        fakeReq({ 'x-trace-id': '20000000-0000-4000-8000-000000000002' }),
        fakeRes() as unknown as ServerResponse,
      ),
    ])

    expect(requestContexts).toHaveLength(2)
    expect(requestContexts.map(requestContext => getTraceId(requestContext))).toEqual([null, null])
  })
})
