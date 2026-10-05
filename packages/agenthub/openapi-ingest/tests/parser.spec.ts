/**
 * OpenAPI 3.x 解析（P3 方案书阶段 C T5 / §4.3）。
 *
 * 覆盖：`$ref` 就地展开（本地 Pointer）、path 级 parameters 合并、请求体提取，
 * 以及「不支持特性报错跳过 + 回执」与「整段失败」两类错误的边界。
 *
 * @module tests/parser.spec
 */
import { describe, expect, it } from 'vitest'
import { AgenthubError } from '@agenthub/_shared'
import {
  HTTP_METHODS,
  SKIP_REASONS,
  parseOpenApiDocument,
  type ParsedDocument,
  type ToolDraft,
} from '../src/index.ts'

function catchError(fn: () => unknown): unknown {
  try {
    return fn()
  } catch (caught: unknown) {
    return caught
  }
}

function codeOf(error: unknown): string {
  return error instanceof AgenthubError ? error.code : 'not-agenthub-error'
}

function statusOf(error: unknown): number | undefined {
  return error instanceof AgenthubError ? error.httpStatus : undefined
}

function first(parsed: ParsedDocument): ToolDraft {
  const draft = parsed.drafts[0]
  if (draft === undefined) throw new Error('expected at least one draft')
  return draft
}

interface JsonSchema {
  readonly type?: string
  readonly description?: string
  readonly properties?: Record<string, JsonSchema>
  readonly required?: string[]
}

describe('parseOpenApiDocument · 展开与合并（T5）', () => {
  it('展开 $ref 参数（components.parameters）并合并 path 级 parameters，required 顺序为 path → operation', () => {
    const parsed = parseOpenApiDocument({
      openapi: '3.0.3',
      paths: {
        '/items/{id}': {
          parameters: [{ $ref: '#/components/parameters/IdParam' }],
          get: {
            operationId: 'getItem',
            summary: '取单项',
            parameters: [
              { name: 'verbose', in: 'query', required: true, schema: { type: 'boolean' }, description: '冗余输出' },
            ],
          },
        },
      },
      components: {
        parameters: {
          IdParam: { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '主键' },
        },
      },
    })
    expect(parsed.total).toBe(1)
    expect(parsed.skipped).toEqual([])
    const draft = first(parsed)
    expect(draft.name).toBe('getItem')
    expect(draft.description).toBe('取单项')
    expect(draft.sourceRef).toBe('GET /items/{id}')
    expect(draft.method).toBe('GET')
    expect(draft.path).toBe('/items/{id}')
    const parameters = draft.parameters as { type: string; properties: Record<string, JsonSchema>; required?: string[] }
    expect(parameters.type).toBe('object')
    expect(parameters.properties.id).toEqual({ type: 'string', description: '主键' })
    expect(parameters.properties.verbose).toEqual({ type: 'boolean', description: '冗余输出' })
    expect(parameters.required).toEqual(['id', 'verbose'])
  })

  it('展开 $ref 请求体（components.requestBodies）并提取 application/json 的 properties 与 required', () => {
    const parsed = parseOpenApiDocument({
      openapi: '3.1.0',
      paths: {
        '/orders': {
          post: {
            operationId: 'createOrder',
            requestBody: { $ref: '#/components/requestBodies/OrderBody' },
          },
        },
      },
      components: {
        requestBodies: {
          OrderBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
              },
            },
          },
        },
      },
    })
    const draft = first(parsed)
    expect(draft.name).toBe('createOrder')
    expect(draft.description).toBe('createOrder')
    const parameters = draft.parameters as { properties: Record<string, JsonSchema>; required?: string[] }
    expect(parameters.properties.sku).toEqual({ type: 'string' })
    expect(parameters.required).toEqual(['sku'])
  })

  it('GET 请求体被忽略（HTTP 语义：无 body），仍产出草稿', () => {
    const parsed = parseOpenApiDocument({
      openapi: '3.0.3',
      paths: {
        '/x': {
          get: {
            operationId: 'readX',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } } } },
          },
        },
      },
    })
    const draft = first(parsed)
    const parameters = draft.parameters as { properties: Record<string, unknown> }
    expect(parameters.properties).toEqual({})
  })

  it('多 method 按 HTTP_METHODS 顺序产出，total 计入全部 operation', () => {
    const parsed = parseOpenApiDocument({
      openapi: '3.0.3',
      paths: {
        '/multi': {
          delete: { operationId: 'dropMulti' },
          get: { operationId: 'readMulti' },
          post: { operationId: 'writeMulti' },
        },
      },
    })
    expect(HTTP_METHODS).toEqual(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
    expect(parsed.total).toBe(3)
    expect(parsed.drafts.map(draft => draft.name)).toEqual(['readMulti', 'writeMulti', 'dropMulti'])
    expect(parsed.skipped).toEqual([])
  })
})

describe('parseOpenApiDocument · 单 operation 坏例（报错跳过 + 回执）', () => {
  function skipReason(paths: Record<string, unknown>, doc?: Record<string, unknown>): string | undefined {
    const parsed = parseOpenApiDocument({ openapi: '3.0.3', paths, ...doc })
    expect(parsed.drafts).toEqual([])
    return parsed.skipped[0]?.reason
  }

  it('缺失 operationId → missing_operation_id', () => {
    expect(skipReason({ '/x': { get: { summary: 'no id' } } })).toBe(SKIP_REASONS.missingOperationId)
  })

  it('外部 $ref → unsupported_external_ref', () => {
    expect(
      skipReason({
        '/x': {
          get: { operationId: 'x', parameters: [{ name: 'p', in: 'query', schema: { $ref: 'https://e.test/a.json#/P' } }] },
        },
      }),
    ).toBe(SKIP_REASONS.unsupportedExternalRef)
  })

  it('断链本地 $ref → unresolved_ref', () => {
    expect(
      skipReason({
        '/x': {
          get: { operationId: 'x', parameters: [{ name: 'p', in: 'query', schema: { $ref: '#/components/schemas/Nope' } }] },
        },
      }),
    ).toBe(SKIP_REASONS.unresolvedRef)
  })

  it('循环 $ref → unsupported_circular_ref', () => {
    expect(
      skipReason(
        {
          '/x': {
            get: { operationId: 'x', parameters: [{ name: 'p', in: 'query', schema: { $ref: '#/components/schemas/Node' } }] },
          },
        },
        { components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } } },
      ),
    ).toBe(SKIP_REASONS.circularRef)
  })

  it('参数缺 schema（OpenAPI 2 写法）→ unsupported_parameter', () => {
    expect(
      skipReason({ '/x': { get: { operationId: 'x', parameters: [{ name: 'p', in: 'query', type: 'string' }] } } }),
    ).toBe(SKIP_REASONS.unsupportedParameter)
  })

  it('非 application/json 请求体 → unsupported_request_body', () => {
    expect(
      skipReason({
        '/x': {
          post: { operationId: 'x', requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } } },
        },
      }),
    ).toBe(SKIP_REASONS.unsupportedRequestBody)
  })

  it('单个坏 operation 不阻断其余（回执保留 sourceRef，total 计入两者）', () => {
    const parsed = parseOpenApiDocument({
      openapi: '3.0.3',
      paths: {
        '/good': { get: { operationId: 'okRead' } },
        '/bad': { post: { summary: 'no id' } },
      },
    })
    expect(parsed.total).toBe(2)
    expect(parsed.drafts.map(draft => draft.name)).toEqual(['okRead'])
    expect(parsed.skipped).toEqual([{ name: null, sourceRef: 'POST /bad', reason: SKIP_REASONS.missingOperationId }])
  })

  it('path-item 级 $ref 展开失败 → 记为一项跳过（sourceRef 为 null）', () => {
    const parsed = parseOpenApiDocument({
      openapi: '3.0.3',
      paths: { '/ref': { $ref: 'https://e.test/path.json#/X' } },
    })
    expect(parsed.drafts).toEqual([])
    expect(parsed.skipped).toEqual([{ name: null, sourceRef: null, reason: SKIP_REASONS.unsupportedExternalRef }])
  })
})

describe('parseOpenApiDocument · C-1 path 键安全（逃逸同源 → 跳过 + 回执）', () => {
  it('绝对 URL / 协议相对 / 反斜杠 path → unsafe_path，不产草稿', () => {
    for (const bad of ['https://evil.test/x', '//evil.test/x', '/\\evil.test/x', '/a\\b']) {
      const parsed = parseOpenApiDocument({ openapi: '3.0.3', paths: { [bad]: { get: { operationId: 'evil' } } } })
      expect(parsed.drafts).toEqual([])
      expect(parsed.skipped).toEqual([{ name: null, sourceRef: null, reason: SKIP_REASONS.unsafePath }])
    }
  })

  it('正常站内 path（/x）不受影响', () => {
    const parsed = parseOpenApiDocument({ openapi: '3.0.3', paths: { '/x': { get: { operationId: 'ok' } } } })
    expect(parsed.drafts.map(draft => draft.name)).toEqual(['ok'])
    expect(parsed.skipped).toEqual([])
  })
})

describe('parseOpenApiDocument · 整段失败（不支持文档）', () => {
  it('非 JSON 对象 → InvalidDocument(422)', () => {
    const error = catchError(() => parseOpenApiDocument(null))
    expect(codeOf(error)).toBe('agenthub/openapi-ingest/InvalidDocument')
    expect(statusOf(error)).toBe(422)
  })

  it('非 3.x 版本 → UnsupportedDocument(422)', () => {
    const error = catchError(() => parseOpenApiDocument({ openapi: '2.0', paths: {} }))
    expect(codeOf(error)).toBe('agenthub/openapi-ingest/UnsupportedDocument')
    expect(statusOf(error)).toBe(422)
  })

  it('缺 paths 对象 → InvalidDocument(422)', () => {
    const error = catchError(() => parseOpenApiDocument({ openapi: '3.0.3' }))
    expect(codeOf(error)).toBe('agenthub/openapi-ingest/InvalidDocument')
    expect(statusOf(error)).toBe(422)
  })
})
