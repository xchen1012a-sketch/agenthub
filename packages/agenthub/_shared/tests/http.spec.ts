import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AgenthubError, readFormBody, readJsonBody, sendError, sendJson, traceIdOf } from '../src/index.ts'

function fakeReq(headers: Record<string, string> = {}, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    headers,
    url: '/x',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function fakeRes(): FakeResponse {
  return {
    statusCode: 0,
    headersSent: false,
    headers: new Map<string, string>(),
    body: '',
    setHeader(key: string, value: string) {
      this.headers.set(key, value)
    },
    end(body?: string) {
      this.body = body ?? ''
    },
  }
}

interface FakeResponse {
  statusCode: number
  headersSent: boolean
  headers: Map<string, string>
  body: string
  setHeader(key: string, value: string): void
  end(body?: string): void
}

describe('traceIdOf（OBS-1）', () => {
  it('合法 header 采纳，非法生成新 UUIDv4', () => {
    expect(traceIdOf(fakeReq({ 'x-trace-id': '0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f' })))
      .toBe('0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f')
    expect(traceIdOf(fakeReq({ 'x-trace-id': 'nope' }))).toMatch(/^[0-9a-f-]{36}$/)
    expect(traceIdOf(fakeReq())).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('sendJson / sendError（U5）', () => {
  it('sendJson 序列化并带 content-type 与 x-trace-id', () => {
    const res = fakeRes()
    sendJson(res as unknown as ServerResponse, 200, { ok: true }, 'tid-1')
    expect(res.statusCode).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('x-trace-id')).toBe('tid-1')
    expect(res.body).toBe('{"ok":true}')
  })

  it('sendError：AgenthubError 透出 code / httpStatus；未知错误 fail-closed 500', () => {
    const a = fakeRes()
    sendError(a as unknown as ServerResponse, new AgenthubError('agenthub/auth/DevAuthDisabled', 'x', { httpStatus: 503 }), 'tid')
    expect(a.statusCode).toBe(503)
    expect((JSON.parse(a.body) as { code: string }).code).toBe('agenthub/auth/DevAuthDisabled')

    const b = fakeRes()
    sendError(b as unknown as ServerResponse, new Error('internal'), 'tid')
    expect(b.statusCode).toBe(500)
    expect((JSON.parse(b.body) as { code: string }).code).toBe('agenthub/_shared/UnknownError')
  })
})

describe('readJsonBody / readFormBody', () => {
  it('JSON：对象解析；数组 / 非法 / 空体 → undefined（fail-closed）', async () => {
    expect(await readJsonBody(fakeReq({}, '{"a":1}'))).toEqual({ a: 1 })
    expect(await readJsonBody(fakeReq({}, '[1]'))).toBeUndefined()
    expect(await readJsonBody(fakeReq({}, 'not-json'))).toBeUndefined()
    expect(await readJsonBody(fakeReq())).toBeUndefined()
  })

  it('表单：urlencoded 解析', async () => {
    const form = await readFormBody(fakeReq({}, 'name=%E5%B9%B3%E5%8F%B0%E7%BB%84'))
    expect(form.get('name')).toBe('平台组')
  })
})

describe('请求体上限（1MB，OOM 防护）', () => {
  it('readFormBody 超 1MB → 空表单（不缓冲明文，调用方走缺字段 fail-closed）', async () => {
    const oversized = [Buffer.alloc(600 * 1024, 1), Buffer.alloc(600 * 1024, 2)]
    const body = await readFormBody((async function* () {
      for (const chunk of oversized) yield chunk
    })() as unknown as IncomingMessage)
    expect(body.size).toBe(0)
  })

  it('readFormBody 边界内不误伤：大表单字段完整解析', async () => {
    const padding = 'x'.repeat(200 * 1024)
    const form = await readFormBody(fakeReq({}, `name=${padding}`))
    expect(form.get('name')).toHaveLength(200 * 1024)
  })

  it('readJsonBody 超 1MB → undefined', async () => {
    const oversized = [Buffer.alloc(600 * 1024), Buffer.alloc(600 * 1024)]
    const body = await readJsonBody((async function* () {
      for (const chunk of oversized) yield chunk
    })() as unknown as IncomingMessage)
    expect(body).toBeUndefined()
  })
})
