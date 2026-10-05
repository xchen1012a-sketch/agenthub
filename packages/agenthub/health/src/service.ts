/**
 * 健康探针（阶段书 §3.1 #13 / V1）。
 *
 * @module @agenthub/health/service
 */
import { createLogger, type Logger } from '@agenthub/_shared'
import type { Queryable } from './db.ts'

export interface HealthReport {
  readonly status: 'ok' | 'degraded'
  readonly version: string
  readonly db: 'ok' | 'error'
}

export class HealthService {
  private readonly logger: Logger

  constructor(
    private readonly db: Queryable,
    options: { version?: string; logger?: Logger } = {},
  ) {
    this.logger = options.logger ?? createLogger('agenthub/health')
  }

  /** 版本取 AGENTHUB_VERSION（部署注入 git sha），缺省 'dev'。 */
  get version(): string {
    return process.env.AGENTHUB_VERSION ?? 'dev'
  }

  /** DB 探活：`select 1`；任何异常都归一为 degraded，不向客户端外泄错误细节。traceId 随请求贯穿（OBS-1）。 */
  async check(traceId: string | null): Promise<HealthReport> {
    try {
      await this.db.query('SELECT 1')
      return { status: 'ok', version: this.version, db: 'ok' }
    } catch (error) {
      this.logger.error(
        { event: 'health.db-error', projectId: null, userId: null, traceId, sessionId: null },
        { error: error instanceof Error ? error.name : 'unknown' },
      )
      return { status: 'degraded', version: this.version, db: 'error' }
    }
  }
}
