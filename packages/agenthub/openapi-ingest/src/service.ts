/**
 * OpenAPI 导入服务（P3 方案书阶段 C T5 / §4.3）。
 *
 * `ingestFromUrl` 拉取/取缓存文档 → `ingestFromJson` 解析 → 逐 operation 落
 * `tools` 草稿行（`source='openapi'`、`enabled=false`、`risk_level='read'`）。
 * `name` 冲突（`operationId` 重复，0007 唯一约束）经 `ON CONFLICT DO NOTHING`
 * 跳过并计入回执——不静默吞掉，也不整段失败。
 *
 * 风险分级（阶段 C3-A）：注入 `classifyRisk` 端口时按 LLM 结论落 `risk_level`；
 * 未注入即关闭分级，草稿一律 `risk_level='read'`。分级失败**不阻断导入**，
 * 但必须记入回执（`.ai-spec/00-boundaries.md` BND-3 默认拒绝 / QA-6 显式降级）。
 *
 * @module @agenthub/openapi-ingest/service
 */
import { AgenthubError, createLogger, isBlockedHost, isOutboundTargetAllowed, nearestAllowedHost, type Logger, type Queryable } from '@agenthub/_shared'
import { inferAuthMode } from './auth-infer.ts'
import { parseOpenApiDocument } from './parser.ts'
import type { IngestOptions, IngestReceipt, SkippedOperation } from './types.ts'
import type { ScanPhase, ScanProgress, ScanRegistry } from './progress.ts'

/** 落库语句（显式列名；`parameters` 走 jsonb；冲突即跳过）。 */
const INSERT_TOOL_SQL =
  'INSERT INTO tools (name, description, parameters, source, source_ref, system_connection_id, risk_level, enabled, created_by)'
  + ' VALUES ($1, $2, $3::jsonb, \'openapi\', $4, $5, $7, false, $6)'
  + ' ON CONFLICT (system_connection_id, name) WHERE system_connection_id IS NOT NULL DO NOTHING'
  + ' RETURNING id'

/** 归入连接所属项目，但 tools.enabled 仍为 false，对话在启用前看不见。 */
const ASSIGN_TOOL_SQL =
  'INSERT INTO project_tool_set (project_id, tool_id, enabled)'
  + ' SELECT p.id, $1, true FROM projects p WHERE p.system_connection_id = $2'
  + ' ON CONFLICT (project_id, tool_id) DO NOTHING'

/** operationId 冲突原因（回执 `SkippedOperation.reason`）。 */
export const DUPLICATE_REASON = 'duplicate_operation_id'

/** 分级本身失败（LLM 不可用 / 超时 / 返回非法等级）时的回落原因。 */
export const RISK_FAILED_REASON = 'risk_classification_failed'

/** 分级返回越界枚举时的原因（与"调用失败"区分，便于排查是模型还是网络问题）。 */
export const RISK_INVALID_REASON = 'invalid_risk_level'

/** `tools.risk_level` 值域（0007 CHECK；越界值禁止入库）。 */
export type RiskLevel = 'read' | 'write' | 'sensitive' | 'critical'

const RISK_LEVELS: readonly RiskLevel[] = ['read', 'write', 'sensitive', 'critical']

/** 分级输入：草稿的可判语义（不含凭证或正文）。 */
export interface RiskClassificationInput {
  readonly name: string
  readonly description: string
}

/** 风险分级端口（生产实现接 LLM；测试注入替身）。 */
export type RiskClassifier = (input: RiskClassificationInput) => Promise<RiskLevel>

/** 判定模型返回值是否为合法等级。 */
export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
}

/** C-4：拉取文档的超时（毫秒）与响应体上限（防慢速挂起 / 内存放大 DoS）。 */
function isApiDocument(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as { openapi?: unknown; swagger?: unknown }
  return typeof record.openapi === 'string' || typeof record.swagger === 'string'
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_DOC_BYTES = 8 * 1024 * 1024

export interface OpenApiIngestOptions {
  /** fetch 注入（测试用 mock 或断言替身）。 */
  readonly fetchImpl?: typeof fetch
  readonly logger?: Logger
  /**
   * 风险分级端口。**不注入即关闭分级**，草稿一律 `risk_level='read'`（P3 行为）。
   * 注入后分级失败不阻断导入，但**必须**记入回执（`BND-3` 默认拒绝 / `QA-6` 显式降级）。
   */
  readonly classifyRisk?: RiskClassifier
  /**
   * 扫描进度注册表（可选）。注入后每次 `ingestFromUrl` 都会把阶段与计数写进去，
   * 供弹窗订阅；不注入即无进度可见性（测试与纯服务用法不受影响）。
   */
  readonly progress?: ScanRegistry
}

/**
 * 导入过程中的阶段回调（可选）。
 *
 * 只用于把进度报给订阅者（弹窗 / 日志）；不改变导入行为，异常也不影响结果——
 * 进度是观测，不是控制流。
 */
export type IngestProgressReporter = (phase: 'fetching' | 'parsing' | 'grading' | 'writing', processed: number, total: number | null) => void

export class OpenApiIngestService {
  private readonly logger: Logger
  private readonly fetchImpl: typeof fetch
  private readonly classifyRisk: RiskClassifier | undefined
  private readonly progress: ScanRegistry | undefined

  constructor(
    private readonly db: Queryable,
    options: OpenApiIngestOptions = {},
  ) {
    this.logger = options.logger ?? createLogger('agenthub/openapi-ingest')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.classifyRisk = options.classifyRisk
    this.progress = options.progress
  }

  /** 解析 JSON 文档并落草稿行；返回 created / skipped / total 回执。 */
  async ingestFromJson(json: unknown, options: IngestOptions & { onProgress?: IngestProgressReporter } = {}): Promise<IngestReceipt> {
    const report = options.onProgress
    report?.('parsing', 0, null)
    const parsed = parseOpenApiDocument(json)
    const created: string[] = []
    const skipped: SkippedOperation[] = [...parsed.skipped]
    const total = parsed.drafts.length
    let index = 0
    for (const draft of parsed.drafts) {
      index += 1
      // 分级可能逐个调用模型（940 个 operation 会很久），因此按 operation 报进度；
      // 未开分级时同样上报，调用方可据此显示"已处理 N 条"。
      report?.(this.classifyRisk === undefined ? 'writing' : 'grading', index, total)
      const { level, failure } = await this.resolveRisk(draft.name, draft.description)
      if (failure !== null) {
        skipped.push({ name: draft.name, sourceRef: draft.sourceRef, reason: failure })
      }
      const { rows } = await this.db.query<{ id: string }>(INSERT_TOOL_SQL, [
        draft.name,
        draft.description,
        JSON.stringify(draft.parameters),
        draft.sourceRef,
        options.systemConnectionId ?? null,
        options.createdBy ?? null,
        level,
      ])
      const inserted = rows[0]
      if (inserted !== undefined) {
        created.push(draft.name)
        if (options.systemConnectionId !== undefined) {
          await this.db.query(ASSIGN_TOOL_SQL, [inserted.id, options.systemConnectionId])
        }
      } else skipped.push({ name: draft.name, sourceRef: draft.sourceRef, reason: DUPLICATE_REASON })
    }
    this.logger.info(
      {
        event: 'openapi.ingested',
        projectId: null,
        userId: options.createdBy ?? null,
        traceId: null,
        sessionId: null,
      },
      {
        systemConnectionId: options.systemConnectionId ?? null,
        total: parsed.total,
        created: created.length,
        skipped: skipped.length,
      },
    )
    return { created, skipped, total: parsed.total }
  }

  /**
   * 草稿的风险等级：有分级端口就用其结论，否则回落 `read`（最保守）。
   *
   * 拿不到结论**不阻断导入**，但必须回传失败原因供回执记录（`BND-3` 默认拒绝 /
   * `QA-6` 降级必须显式）：`failure` 非 null 时调用方必须把它写进 `skipped`。
   * @param name - 草稿名（即 operationId）。
   * @param description - 草稿描述（operation summary）。
   * @returns 落库用的等级与失败原因（无失败时为 null）。
   */
  private async resolveRisk(
    name: string,
    description: string,
  ): Promise<{ level: RiskLevel; failure: string | null }> {
    if (this.classifyRisk === undefined) return { level: 'read', failure: null }
    let level: RiskLevel
    try {
      level = await this.classifyRisk({ name, description })
    } catch (error) {
      this.logger.warn(
        {
          event: 'openapi.risk-classification-failed',
          projectId: null,
          userId: null,
          traceId: null,
          sessionId: null,
        },
        { tool: name, reason: error instanceof Error ? error.message : String(error) },
      )
      return { level: 'read', failure: RISK_FAILED_REASON }
    }
    if (!isRiskLevel(level)) return { level: 'read', failure: RISK_INVALID_REASON }
    return { level, failure: null }
  }

  /** 按连接取文档（优先 `openapi_url` 拉取，回退缓存 `openapi_doc`）后导入。 */
  async ingestFromUrl(
    systemConnectionId: string,
    options: IngestOptions & { onProgress?: IngestProgressReporter } = {},
  ): Promise<IngestReceipt> {
    const startedAt = new Date().toISOString()
    /** 把阶段写入注册表（未注入注册表时是空操作）。 */
    const publish = (phase: ScanPhase, processed: number, total: number | null, extra: Partial<ScanProgress> = {}): void => {
      this.progress?.publish({ connectionId: systemConnectionId, phase, processed, total, startedAt, ...extra })
    }
    const report: IngestProgressReporter = (phase, processed, total) => {
      options.onProgress?.(phase, processed, total)
      publish(phase, processed, total)
    }

    try {
      report('fetching', 0, null)
      const { rows } = await this.db.query<{
        base_url: string | null
        openapi_url: string | null
        openapi_doc: unknown
        allowed_hosts: string[]
      }>(
        'SELECT base_url, openapi_url, openapi_doc, allowed_hosts FROM system_connections WHERE id = $1',
        [systemConnectionId],
      )
      const row = rows[0]
      if (row === undefined) {
        throw new AgenthubError('agenthub/openapi-ingest/ConnectionNotFound', '系统连接不存在', { httpStatus: 404 })
      }
      const discovered = await this.discoverDocument(systemConnectionId, row)
      const doc = discovered ?? await this.resolveDocument(row.openapi_url, row.openapi_doc, row.allowed_hosts)
      await this.db.query(
        'UPDATE system_connections SET auth_mode = $2, updated_at = now() WHERE id = $1',
        [systemConnectionId, inferAuthMode(doc)],
      )
      const receipt = await this.ingestFromJson(doc, { ...options, systemConnectionId, onProgress: report })
      publish('done', receipt.created.length + receipt.skipped.length, receipt.total, {
        created: receipt.created.length,
        skipped: receipt.skipped.length,
        finishedAt: new Date().toISOString(),
      })
      return receipt
    } catch (error) {
      // 失败也要落状态：弹窗关闭后重新打开仍应看到"上次失败及原因"。
      publish('failed', 0, null, {
        reason: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      })
      throw error
    }
  }

  /**
   * 没有文档地址时，按后端地址尝试常见文档路径。
   * 内网未放行时不发请求，并说明要去白名单页。找不到则返回 null，交给后续缺文档错误。
   */
  private async discoverDocument(connectionId: string, row: {
    base_url: string | null
    openapi_url: string | null
    openapi_doc: unknown
    allowed_hosts: string[]
  }): Promise<unknown | null> {
    if (row.openapi_url !== null && row.openapi_url !== '') return null
    if (row.openapi_doc !== null && row.openapi_doc !== undefined) return null
    if (row.base_url === null || row.base_url === undefined || row.base_url === '') return null
    const backend = new URL(row.base_url)
    if (!isOutboundTargetAllowed(backend.hostname, row.allowed_hosts)) {
      throw new AgenthubError(
        'agenthub/openapi-ingest/NotAllowlisted',
        `内网地址尚未放行：${backend.hostname}。请在该连接的白名单页放入对应主机后再继续`,
        { httpStatus: 409 },
      )
    }
    for (const path of ['/openapi.json', '/swagger.json', '/v3/api-docs']) {
      const url = new URL(path, backend).toString()
      try {
        const doc = await this.fetchDocument(url, row.allowed_hosts)
        if (!isApiDocument(doc)) continue
        await this.db.query(
          'UPDATE system_connections SET openapi_url = $2, openapi_doc = $3::jsonb, updated_at = now() WHERE id = $1',
          [connectionId, url, JSON.stringify(doc)],
        )
        return doc
      } catch {
        continue
      }
    }
    return null
  }

/** 文档来源：URL 优先（取最新），其次缓存列，两者皆无 → 422。 */
  private async resolveDocument(url: string | null, cached: unknown, allowedHosts: readonly string[]): Promise<unknown> {
    if (url !== null && url !== '') return await this.fetchDocument(url, allowedHosts)
    if (cached !== null && cached !== undefined) return cached
    throw new AgenthubError(
      'agenthub/openapi-ingest/MissingOpenApiSource',
      '该连接既无 openapi_url 也无缓存 openapi_doc，无法导入',
      { httpStatus: 422 },
    )
  }

  /**
   * 拉取并解析 JSON（网络 / 状态 / JSON 失败分别抛 AgenthubError）。
   *
   * 受限地址（内网 / 环回 / 链路本地 / 元数据）只有在该连接的 `allowed_hosts` 里
   * 显式授权时才放行；放行会写一条结构化日志，使"谁授权了内网目标"可追溯。
   * @param url - 文档地址。
   * @param allowedHosts - 该连接声明的白名单。
   * @returns 解析后的文档对象。
   */
  private async fetchDocument(url: string, allowedHosts: readonly string[]): Promise<unknown> {
    // C-4：拉取前 SSRF 校验（仅 http/https；受限地址需白名单授权）。
    assertSafeSourceUrl(url, allowedHosts)
    // 受限地址走到这里说明白名单放行了它——记一条日志，让"谁授权了内网目标"可追溯。
    const host = new URL(url).hostname
    if (isBlockedHost(host)) {
      this.logger.warn(
        { event: 'ingest.private-target-allowed', projectId: null, userId: null, traceId: null, sessionId: null },
        { host, allowedHosts },
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    } catch (error) {
      throw new AgenthubError('agenthub/openapi-ingest/SourceUnreachable', `拉取 OpenAPI 文档失败：${url}`, {
        httpStatus: 502,
        cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new AgenthubError(
        'agenthub/openapi-ingest/SourceUnreachable',
        `OpenAPI 文档返回 ${response.status}：${url}`,
        { httpStatus: 502 },
      )
    }
    // C-4：响应体上限（先看 content-length，读取后兜底实际字节数）。
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
      throw new AgenthubError('agenthub/openapi-ingest/SourceTooLarge', `OpenAPI 文档超过体积上限：${url}`, { httpStatus: 502 })
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw new AgenthubError('agenthub/openapi-ingest/SourceUnreachable', `读取 OpenAPI 文档失败：${url}`, {
        httpStatus: 502,
        cause: error,
      })
    }
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) {
      throw new AgenthubError('agenthub/openapi-ingest/SourceTooLarge', `OpenAPI 文档超过体积上限：${url}`, { httpStatus: 502 })
    }
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new AgenthubError('agenthub/openapi-ingest/InvalidDocument', 'OpenAPI 文档不是合法 JSON', {
        httpStatus: 422,
        cause: error,
      })
    }
  }
}

/**
 * C-4：来源 URL 安全校验——仅 http/https；受限地址（内网 / 环回 / 链路本地 / 元数据）
 * 只有在该连接的 `allowed_hosts` 中显式授权时才放行。
 * @param value - 待校验的文档地址。
 * @param allowedHosts - 该连接声明的白名单。
 * @throws AgenthubError 非法协议或受限地址未被授权（422）。
 */
function assertSafeSourceUrl(value: string, allowedHosts: readonly string[]): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgenthubError('agenthub/openapi-ingest/InvalidSourceUrl', 'openapi_url 必须是合法 URL', { httpStatus: 422 })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgenthubError('agenthub/openapi-ingest/InvalidSourceUrl', 'openapi_url 仅支持 http/https', { httpStatus: 422 })
  }
  if (!isOutboundTargetAllowed(url.hostname, allowedHosts)) {
    const near = nearestAllowedHost(url.hostname, allowedHosts)
    const hint = near === null ? '' : `；白名单里有「${near}」，是否想写「${url.hostname}」？`
    throw new AgenthubError(
      'agenthub/openapi-ingest/UnsafeSourceUrl',
      `openapi_url 指向受限地址（${url.hostname}），未在该连接的白名单中授权${hint}`,
      { httpStatus: 422 },
    )
  }
}
