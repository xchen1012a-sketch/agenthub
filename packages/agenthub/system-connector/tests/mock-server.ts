/**
 * mock 外部系统（P3 方案书 §4.3；仅测试用，不进 src）。
 *
 * 双模式共用：
 * - api_token：`GET /anything`（200）/ `POST /write-anything`（校验 Authorization，缺/错 → 403）；
 * - session：`POST /login`（校验账密 → Set-Cookie）/ `POST /session-write`（校验 Cookie，缺/错 → 403）；
 * - `GET /openapi.json`：OpenAPI 3.x 文档，覆盖上述三个 operation（供 ingest 测试）。
 *
 * 回显永不包含 token 明文（V5：集成测试注入标记 token 后 grep 命中 = 0）。
 *
 * @module tests/mock-server
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { createServer } from 'node:http'

/** V5 标记 token（方案书阶段 C 预期标准 6）。 */
export const MOCK_TOKEN = 'my-secret-token-12345'
export const MOCK_USERNAME = 'demo'
export const MOCK_PASSWORD = 'demo-pass'
export const MOCK_COOKIE_NAME = 'sid'

/** 三个 operation 的 OpenAPI 3.x 文档（ingestFromJson 出 ≥ 3 草稿行的输入源）。 */
export const MOCK_OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'AgentHub Mock System', version: '1.0.0' },
  paths: {
    '/anything': {
      get: {
        operationId: 'readAnything',
        summary: '读取任意内容（api_token 模式）',
        parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/write-anything': {
      post: {
        operationId: 'writeAnything',
        summary: '写入任意内容（api_token 模式，Authorization 校验）',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'ok' }, 403: { description: 'forbidden' } },
      },
    },
    '/session-write': {
      post: {
        operationId: 'sessionWrite',
        summary: '写入任意内容（session 模式，Cookie 校验）',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'ok' }, 403: { description: 'forbidden' } },
      },
    },
  },
} as const

export interface MockSystem {
  readonly baseUrl: string
  readonly openapiUrl: string
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

interface JsonResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

function json(res: JsonResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function parseJson(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 起 mock 系统（随机端口），返回 baseUrl 与关闭句柄。 */
export async function startMockSystem(): Promise<MockSystem> {
  const sessions = new Set<string>()
  const server = createServer({ keepAlive: false }, (req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://mock')
      const body = await readBody(req)
      if (req.method === 'GET' && url.pathname === '/openapi.json') {
        json(res, 200, MOCK_OPENAPI)
        return
      }
      if (req.method === 'GET' && url.pathname === '/anything') {
        json(res, 200, { ok: true, path: '/anything', query: Object.fromEntries(url.searchParams) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/write-anything') {
        if (req.headers.authorization !== MOCK_TOKEN) {
          json(res, 403, { error: 'forbidden' })
          return
        }
        json(res, 200, { ok: true, wrote: parseJson(body) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/admin-api/system/auth/login') {
        json(res, 200, { tenant: req.headers['tenant-id'] ?? null })
        return
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const credentials = parseJson(body)
        if (credentials.username !== MOCK_USERNAME || credentials.password !== MOCK_PASSWORD) {
          json(res, 401, { error: 'invalid-credentials' })
          return
        }
        const sid = randomUUID()
        sessions.add(sid)
        res.setHeader('set-cookie', `${MOCK_COOKIE_NAME}=${sid}; Path=/; HttpOnly; Max-Age=3600`)
        json(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/session-write') {
        const sid = new RegExp(`(?:^|;\\s*)${MOCK_COOKIE_NAME}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1]
        if (sid === undefined || !sessions.has(sid)) {
          json(res, 403, { error: 'forbidden' })
          return
        }
        json(res, 200, { ok: true, wrote: parseJson(body) })
        return
      }
      json(res, 404, { error: 'not-found' })
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const baseUrl = `http://127.0.0.1:${String(port)}`
  return {
    baseUrl,
    openapiUrl: `${baseUrl}/openapi.json`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    }),
  }
}
