/**
 * OpenAPI 3.x 文档 → Tool 草稿（P3 方案书阶段 C T5 / §4.3）。
 *
 * 纯函数、无 IO：解析 `paths` → operation 级草稿行；`$ref` 就地展开（仅本地
 * `#/...` JSON Pointer）；不支持的特性（外部 $ref / 循环 $ref / 无 schema 参数 /
 * 非 application/json 请求体 / 缺失 operationId）**报错跳过**并把原因写进回执，
 * 不抛整段失败——单个坏 operation 不应阻断其余导入。
 *
 * 无 LLM 风险分级（P4）：草稿 `risk_level` 一律默认 `read`（由落库侧写入）。
 *
 * @module @agenthub/openapi-ingest/parser
 */
import { AgenthubError } from '@agenthub/_shared'
import type { SkippedOperation, ToolDraft } from './types.ts'

/** OpenAPI 3.x 允许的 HTTP method（顺序即扫描顺序，保证草稿顺序确定）。 */
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

/** 跳过原因闭集（回执 `SkippedOperation.reason`）。 */
export const SKIP_REASONS = {
  missingOperationId: 'missing_operation_id',
  unsupportedExternalRef: 'unsupported_external_ref',
  unresolvedRef: 'unresolved_ref',
  circularRef: 'unsupported_circular_ref',
  unsupportedParameter: 'unsupported_parameter',
  unsupportedRequestBody: 'unsupported_request_body',
  /** C-1：path 键非法（绝对 URL / 协议相对 / 反斜杠歧义）——会逃逸 base_url 同源，跳过。 */
  unsafePath: 'unsafe_path',
  /** operationId 不含任何可用字符（全中文 / 全符号），无法适配成合法工具名。 */
  unnameableOperationId: 'unnameable_operation_id',
} as const

/** 展开深度上限（防深层/循环结构拖垮解析）。 */
const MAX_DEPTH = 24

/**
 * 工具名允许的字符集与长度：函数调用协议对 `tools[].function.name` 的规定。
 * 工具名每次请求都要发给模型服务，服务端在入口校验整个请求体，不合规即整单拒绝，
 * 因此这里必须与协议一致（更严会误伤合法名，更松会把不合规名收进库）。
 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/

/** 规范化中间态：先替换再截断，最后才去掉首尾分隔符。 */
const TOOL_NAME_SEPARATORS = /[^A-Za-z0-9_-]+/g

/** 规范化的最大长度。 */
const TOOL_NAME_MAX = 128

/**
 * 把一个 `operationId` 规范化为模型服务可接受的工具名。
 *
 * 不同业务系统的 `operationId` 写法各异（`user.get` / `user/get` / 中英混写），
 * 导入时**适配**而不是要求对方改写：非法字符折为一个 `_`，首尾分隔符去掉，
 * 超长按上限截断（截断处若落在分隔符上则一并去掉）。
 *
 * 规范化会改变名字，调用方应把原始 `operationId` 记录在工具描述里以便追溯。
 * @param raw - 原始 `operationId`。
 * @returns 合法工具名；原始值不含任何可用字符时为 `undefined`（调用方跳过）。
 */
export function normalizeToolName(raw: string): string | undefined {
  const replaced = raw.trim().replace(TOOL_NAME_SEPARATORS, '_').replace(/^_+|_+$/g, '')
  if (replaced === '') return undefined
  const truncated = replaced.slice(0, TOOL_NAME_MAX).replace(/_+$/, '')
  return TOOL_NAME_RE.test(truncated) ? truncated : undefined
}

/** 解析结果（草稿 + 跳过项 + operation 总数）。 */
export interface ParsedDocument {
  readonly drafts: ToolDraft[]
  readonly skipped: SkippedOperation[]
  readonly total: number
}

/** 单 operation 级失败信号（内部哨兵，不逃出 parseOpenApiDocument）。 */
class SkipError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'SkipError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 本地 JSON Pointer 解析（`#/a/~1b` → doc.a['/b']）；外部引用 / 断链 → SkipError。 */
function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new SkipError(SKIP_REASONS.unsupportedExternalRef)
  const parts = ref
    .slice(2)
    .split('/')
    .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  let current: unknown = doc
  for (const part of parts) {
    if (!isRecord(current)) throw new SkipError(SKIP_REASONS.unresolvedRef)
    const next = current[part]
    if (next === undefined) throw new SkipError(SKIP_REASONS.unresolvedRef)
    current = next
  }
  return current
}

/** 就地展开 `$ref`（含嵌套数组/对象；兄弟键按 OpenAPI 3.1 语义覆盖）。 */
function expandRefs(value: unknown, doc: unknown, seen: ReadonlySet<string> = new Set(), depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new SkipError(SKIP_REASONS.circularRef)
  if (Array.isArray(value)) return value.map(item => expandRefs(item, doc, seen, depth + 1))
  if (!isRecord(value)) return value
  const ref = value.$ref
  if (typeof ref === 'string') {
    if (seen.has(ref)) throw new SkipError(SKIP_REASONS.circularRef)
    const nextSeen = new Set(seen)
    nextSeen.add(ref)
    const resolved = expandRefs(resolvePointer(doc, ref), doc, nextSeen, depth + 1)
    const base = isRecord(resolved) ? resolved : {}
    const siblings: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key !== '$ref') siblings[key] = item
    }
    return { ...base, ...(expandRefs(siblings, doc, nextSeen, depth + 1) as Record<string, unknown>) }
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = expandRefs(item, doc, seen, depth + 1)
  return out
}

/** 合并一个参数对象到 properties/required（无 `schema` 的 OpenAPI 2 写法 → 跳过）。 */
function collectParameter(
  raw: unknown,
  doc: unknown,
  properties: Record<string, unknown>,
  required: string[],
): void {
  const parameter = expandRefs(raw, doc)
  if (!isRecord(parameter) || typeof parameter.name !== 'string' || parameter.name === '') {
    throw new SkipError(SKIP_REASONS.unsupportedParameter)
  }
  const schema = parameter.schema
  if (!isRecord(schema)) throw new SkipError(SKIP_REASONS.unsupportedParameter)
  const property: Record<string, unknown> = { ...schema }
  if (typeof parameter.description === 'string' && property.description === undefined) {
    property.description = parameter.description
  }
  properties[parameter.name] = property
  if (parameter.required === true) required.push(parameter.name)
}

/** 合并 `requestBody`（仅 application/json）到 properties/required。 */
function collectRequestBody(
  raw: unknown,
  doc: unknown,
  properties: Record<string, unknown>,
  required: string[],
): void {
  const body = expandRefs(raw, doc)
  if (!isRecord(body)) throw new SkipError(SKIP_REASONS.unsupportedRequestBody)
  const content = body.content
  const jsonContent = isRecord(content) ? content['application/json'] : undefined
  const schema = isRecord(jsonContent) ? jsonContent.schema : undefined
  if (!isRecord(schema)) throw new SkipError(SKIP_REASONS.unsupportedRequestBody)
  const bodyProperties = schema.properties
  if (!isRecord(bodyProperties)) throw new SkipError(SKIP_REASONS.unsupportedRequestBody)
  for (const [key, item] of Object.entries(bodyProperties)) properties[key] = item
  if (Array.isArray(schema.required)) {
    for (const item of schema.required) {
      if (typeof item === 'string') required.push(item)
    }
  }
}

/** 一个 operation → 草稿（任一步失败抛 SkipError，由上层收敛为回执跳过项）。 */
function toDraft(path: string, method: string, operation: Record<string, unknown>, doc: unknown): ToolDraft {
  const operationId = operation.operationId
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw new SkipError(SKIP_REASONS.missingOperationId)
  }
  // 适配底座命名而不是要求对方改写；无法适配才跳过。
  const name = normalizeToolName(operationId)
  if (name === undefined) throw new SkipError(SKIP_REASONS.unnameableOperationId)
  /** 名字被改过时把原始 operationId 写进描述，保证改名可追溯（不丢信息）。 */
  const renamed = name !== operationId.trim()
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const parameter of pathParametersOf(doc, path)) collectParameter(parameter, doc, properties, required)
  const operationParameters = operation.parameters
  if (operationParameters !== undefined) {
    if (!Array.isArray(operationParameters)) throw new SkipError(SKIP_REASONS.unsupportedParameter)
    for (const parameter of operationParameters) collectParameter(parameter, doc, properties, required)
  }
  if (method !== 'get' && method !== 'head' && operation.requestBody !== undefined) {
    collectRequestBody(operation.requestBody, doc, properties, required)
  }
  const parameters: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) parameters.required = required
  const summary = operation.summary ?? operation.description
  const base = typeof summary === 'string' && summary !== '' ? summary : name
  return {
    name,
    // 改名后附上原始 operationId：名字与业务系统文档对不上时，这里是唯一的线索。
    description: renamed ? `${base}（原名 ${operationId.trim()}）` : base,
    parameters,
    sourceRef: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
  }
}

/** path-item 级 parameters（`$ref` 到本地 path-item 时先展开）。 */
function pathParametersOf(doc: unknown, path: string): unknown[] {
  const paths = isRecord(doc) ? doc.paths : undefined
  if (!isRecord(paths)) return []
  const item = expandRefs(paths[path], doc)
  const parameters = isRecord(item) ? item.parameters : undefined
  return Array.isArray(parameters) ? parameters : []
}

/**
 * 解析 OpenAPI 3.x 文档。
 *
 * - 非 3.x / 非对象 / 缺 `paths` → 抛 AgenthubError（整段失败，非跳过）；
 * - 单个坏 operation → 计入 `skipped` 并继续。
 */
export function parseOpenApiDocument(doc: unknown): ParsedDocument {
  if (!isRecord(doc)) {
    throw new AgenthubError('agenthub/openapi-ingest/InvalidDocument', 'OpenAPI 文档必须是 JSON 对象', { httpStatus: 422 })
  }
  const version = doc.openapi
  if (typeof version !== 'string' || !version.startsWith('3.')) {
    throw new AgenthubError(
      'agenthub/openapi-ingest/UnsupportedDocument',
      `仅支持 OpenAPI 3.x，收到 openapi=${JSON.stringify(version ?? null)}`,
      { httpStatus: 422 },
    )
  }
  if (!isRecord(doc.paths)) {
    throw new AgenthubError('agenthub/openapi-ingest/InvalidDocument', 'OpenAPI 文档缺少 paths 对象', { httpStatus: 422 })
  }

  const drafts: ToolDraft[] = []
  const skipped: SkippedOperation[] = []
  let total = 0
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    // C-1：path 键非法（可逃逸同源）→ 整段跳过并计入回执。
    if (!isSafePath(path)) {
      skipped.push({ name: null, sourceRef: null, reason: SKIP_REASONS.unsafePath })
      continue
    }
    let item: unknown
    try {
      item = expandRefs(rawItem, doc)
    } catch (error) {
      skipped.push({ name: null, sourceRef: null, reason: reasonOf(error) })
      continue
    }
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (operation === undefined) continue
      total += 1
      const sourceRef = `${method.toUpperCase()} ${path}`
      if (!isRecord(operation)) {
        skipped.push({ name: null, sourceRef, reason: SKIP_REASONS.unsupportedParameter })
        continue
      }
      try {
        drafts.push(toDraft(path, method, operation, doc))
      } catch (error) {
        skipped.push({ name: null, sourceRef, reason: reasonOf(error) })
      }
    }
  }
  return { drafts, skipped, total }
}

function reasonOf(error: unknown): string {
  return error instanceof SkipError ? error.reason : SKIP_REASONS.unsupportedParameter
}

/**
 * C-1：path 键安全校验——必须是站内单斜杠相对路径，禁止任何可逃逸 base_url 同源的写法：
 * 绝对 URL（`https://evil/x`）、协议相对（`//evil/x`）、反斜杠歧义（`/\evil/x`、含 `\`）。
 * 不合规的 path 整段跳过并计入回执（不落草稿、不注册工具）。
 */
export function isSafePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !path.includes('://')
}
