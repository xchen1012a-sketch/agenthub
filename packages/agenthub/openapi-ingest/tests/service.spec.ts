/**
 * OpenAPI 导入服务（P3 方案书阶段 C T5 / §4.3）。
 *
 * 覆盖预期标准 2：`ingestFromJson` 出 ≥ 3 个 Tool 草稿行（`operationId` 冲突跳过并回执）；
 * 以及 `ingestFromUrl` 的文档来源优先级（url → 缓存 → 422）与各类失败分支。
 *
 * @module tests/service.spec
 */
import { describe, expect, it } from 'vitest'
import { MOCK_OPENAPI } from '../../system-connector/tests/mock-server.ts'
import { DUPLICATE_REASON, type IngestReceipt } from '../src/index.ts'
import { FakeIngestDb, withDb } from './fakes.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CONN = '22222222-2222-4222-8222-222222222222'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** fetch 替身：记录被请求的 URL，按 handler 返回响应。 */
function fetchStub(handler: (url: string) => Response | Promise<Response>): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    calls.push(url)
    return await handler(url)
  }
  return { impl, calls }
}

function names(receipt: IngestReceipt): string[] {
  return receipt.created
}

describe('OpenApiIngestService · ingestFromJson（T5 / 预期标准 2）', () => {
  it('MOCK_OPENAPI 出 3 个草稿行，source_ref 为 "<METHOD> <path>"，落库为 openapi/enabled=false/risk_level=read', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db)
    const receipt = await service.ingestFromJson(MOCK_OPENAPI, { systemConnectionId: CONN, createdBy: USER })

    expect(receipt.total).toBe(3)
    expect(names(receipt)).toEqual(['readAnything', 'writeAnything', 'sessionWrite'])
    expect(receipt.skipped).toEqual([])

    expect(db.toolRows.map(row => row.source_ref)).toEqual([
      'GET /anything',
      'POST /write-anything',
      'POST /session-write',
    ])
    expect(db.toolRows.every(row => row.system_connection_id === CONN)).toBe(true)
    expect(db.toolRows.every(row => row.created_by === USER)).toBe(true)
    // 未注入分级端口 → 草稿一律 read（阶段 C3-A 起 risk_level 改为参数化落库）。
    expect(db.toolRows.every(row => row.risk_level === 'read')).toBe(true)
    // GET 的 query 参数进入 parameters.properties
    expect(db.toolRows[0]?.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    })

    const insert = db.statements.find(item => item.text.startsWith('INSERT INTO tools'))
    expect(insert?.text).toContain("'openapi'")
    expect(insert?.text).toContain('false')
    expect(insert?.text).toContain('::jsonb')
    expect(insert?.text).toContain('ON CONFLICT (system_connection_id, name) WHERE system_connection_id IS NOT NULL DO NOTHING')
    expect(insert?.text).not.toContain('SELECT *')
  })

  it('operationId 冲突（name 已占用）→ 跳过并回执 duplicate_operation_id，不静默吞掉', async () => {
    const db = new FakeIngestDb()
    db.toolNames.add('readAnything')
    const service = withDb(db)
    const receipt = await service.ingestFromJson(MOCK_OPENAPI)

    expect(receipt.total).toBe(3)
    expect(names(receipt)).toEqual(['writeAnything', 'sessionWrite'])
    expect(receipt.skipped).toEqual([
      { name: 'readAnything', sourceRef: 'GET /anything', reason: DUPLICATE_REASON },
    ])
  })

  it('同一文档内重复 operationId → 后者计入冲突回执', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db)
    const receipt = await service.ingestFromJson({
      openapi: '3.0.3',
      paths: { '/a': { get: { operationId: 'dup' } }, '/b': { get: { operationId: 'dup' } } },
    })
    expect(names(receipt)).toEqual(['dup'])
    expect(receipt.skipped).toEqual([{ name: 'dup', sourceRef: 'GET /b', reason: DUPLICATE_REASON }])
  })

  it('未传 systemConnectionId / createdBy → 落库为 NULL', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db)
    await service.ingestFromJson(MOCK_OPENAPI)
    expect(db.toolRows.every(row => row.system_connection_id === null)).toBe(true)
    expect(db.toolRows.every(row => row.created_by === null)).toBe(true)
  })

  it('不支持文档 → 整段失败并抛 AgenthubError（传播而非跳过）', async () => {
    const db = new FakeIngestDb()
    const service = withDb(db)
    await expect(service.ingestFromJson({ openapi: '2.0', paths: {} })).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/UnsupportedDocument',
      httpStatus: 422,
    })
    expect(db.toolRows).toEqual([])
  })
})

describe('OpenApiIngestService · ingestFromUrl（T5）', () => {
  it('openapi_url 优先：拉取最新文档，缓存列被忽略', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({
      id: CONN,
      openapi_url: 'http://src.test/openapi.json',
      openapi_doc: { openapi: '3.0.3', paths: { '/cached': { get: { operationId: 'cachedOp' } } } },
    })
    const fetcher = fetchStub(() => jsonResponse(MOCK_OPENAPI))
    const service = withDb(db, { fetchImpl: fetcher.impl })
    const receipt = await service.ingestFromUrl(CONN, { createdBy: USER })

    expect(fetcher.calls).toEqual(['http://src.test/openapi.json'])
    expect(names(receipt)).toEqual(['readAnything', 'writeAnything', 'sessionWrite'])
    expect(db.toolRows.every(row => row.system_connection_id === CONN)).toBe(true)
  })

  it('无 openapi_url 时回退缓存 openapi_doc', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({
      id: CONN,
      openapi_url: null,
      openapi_doc: { openapi: '3.0.3', paths: { '/cached': { get: { operationId: 'cachedOp' } } } },
    })
    const service = withDb(db)
    const receipt = await service.ingestFromUrl(CONN)
    expect(receipt.total).toBe(1)
    expect(names(receipt)).toEqual(['cachedOp'])
  })

  it('连接不存在 → ConnectionNotFound(404)', async () => {
    const service = withDb(new FakeIngestDb())
    await expect(service.ingestFromUrl('missing')).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/ConnectionNotFound',
      httpStatus: 404,
    })
  })

  it('既无 url 又无缓存 → MissingOpenApiSource(422)', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({ id: CONN, openapi_url: null, openapi_doc: null })
    const service = withDb(db)
    await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/MissingOpenApiSource',
      httpStatus: 422,
    })
  })

  it('上游非 2xx → SourceUnreachable(502)', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({ id: CONN, openapi_url: 'http://src.test/openapi.json', openapi_doc: null })
    const fetcher = fetchStub(() => jsonResponse({ error: 'boom' }, 500))
    const service = withDb(db, { fetchImpl: fetcher.impl })
    await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/SourceUnreachable',
      httpStatus: 502,
    })
  })

  it('网络异常 → SourceUnreachable(502)', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({ id: CONN, openapi_url: 'http://src.test/openapi.json', openapi_doc: null })
    const fetcher = fetchStub(() => {
      throw new Error('ECONNREFUSED')
    })
    const service = withDb(db, { fetchImpl: fetcher.impl })
    await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/SourceUnreachable',
      httpStatus: 502,
    })
  })

  it('响应体非合法 JSON → InvalidDocument(422)', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({ id: CONN, openapi_url: 'http://src.test/openapi.json', openapi_doc: null })
    const fetcher = fetchStub(() => new Response('<html>not json</html>', { status: 200 }))
    const service = withDb(db, { fetchImpl: fetcher.impl })
    await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/InvalidDocument',
      httpStatus: 422,
    })
  })

  it('C-4：openapi_url 指向环回 / 元数据 / 私网 → UnsafeSourceUrl(422)，不发请求', async () => {
    for (const url of ['http://127.0.0.1/openapi.json', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x', 'http://localhost/x']) {
      const db = new FakeIngestDb()
      db.connectionRows.push({ id: CONN, openapi_url: url, openapi_doc: null })
      const fetcher = fetchStub(() => jsonResponse(MOCK_OPENAPI))
      const service = withDb(db, { fetchImpl: fetcher.impl })
      await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
        code: 'agenthub/openapi-ingest/UnsafeSourceUrl',
        httpStatus: 422,
      })
      expect(fetcher.calls).toEqual([])
    }
  })

  it('C-4：非 http/https → InvalidSourceUrl(422)', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({ id: CONN, openapi_url: 'ftp://src.test/openapi.json', openapi_doc: null })
    const service = withDb(db)
    await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/InvalidSourceUrl',
      httpStatus: 422,
    })
  })

  it('C-4：响应体超上限 → SourceTooLarge(502)', async () => {
    const db = new FakeIngestDb()
    db.connectionRows.push({ id: CONN, openapi_url: 'http://src.test/openapi.json', openapi_doc: null })
    const fetcher = fetchStub(() => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(9 * 1024 * 1024) },
    }))
    const service = withDb(db, { fetchImpl: fetcher.impl })
    await expect(service.ingestFromUrl(CONN)).rejects.toMatchObject({
      code: 'agenthub/openapi-ingest/SourceTooLarge',
      httpStatus: 502,
    })
  })
})
