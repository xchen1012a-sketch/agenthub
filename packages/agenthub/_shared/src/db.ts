/**
 * 共享 PostgreSQL 连接（architecture.md A3 单数据源的进程内落点）。
 *
 * 全进程只允许一个 Pool：由注册顺序最早的 @agenthub/auth 创建并以
 * `agenthub/db` 服务键 provide，后续包（project / health / …）一律经
 * ctx.get('agenthub/db') 消费，禁止各自 new Pool。
 *
 * @module @agenthub/_shared/db
 */
import type { QueryResult, QueryResultRow } from 'pg'
import { Pool } from 'pg'
import { AgenthubError } from './errors.ts'

/** 最小 DB 访问面（pg Pool 结构子集；测试用假实现替代）。 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<R>, 'rows'>>
}

/**
 * 创建全进程唯一的连接池（fail-fast：缺 AGENTHUB_DB_URL 直接启动失败，
 * 不允许静默回退 localhost 造成 fail-late 误诊）。
 */
export function createAgenthubPool(env: Record<string, string | undefined> = process.env): Pool {
  const connectionString = env.AGENTHUB_DB_URL
  if (connectionString === undefined || connectionString === '') {
    throw new AgenthubError(
      'agenthub/_shared/DbUrlMissing',
      'AGENTHUB_DB_URL 未设置；参考 deploy/.env.example（应用经 --env-file-if-exists 加载）',
    )
  }
  const parsed = Number.parseInt(env.AGENTHUB_DB_POOL_SIZE ?? '', 10)
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : 20
  return new Pool({ connectionString, max })
}
