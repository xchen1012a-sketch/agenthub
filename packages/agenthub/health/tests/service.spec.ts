import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import { HealthService } from '../src/index.ts'
import type { Queryable } from '../src/index.ts'

function db(ok: boolean): Queryable {
  return {
    async query<R extends QueryResultRow>(_text: string): Promise<Pick<QueryResult<R>, 'rows'>> {
      if (!ok) throw new Error('connection refused')
      return { rows: [] as R[] }
    },
  }
}

describe('HealthService（阶段书 §3.1 #13 / V1）', () => {
  it('DB 正常 → ok / db:ok', async () => {
    const report = await new HealthService(db(true)).check(null)
    expect(report).toEqual({ status: 'ok', version: 'dev', db: 'ok' })
  })

  it('DB 异常 → degraded / db:error（fail-closed，不外泄错误细节）', async () => {
    const report = await new HealthService(db(false)).check(null)
    expect(report).toEqual({ status: 'degraded', version: 'dev', db: 'error' })
  })

  it('AGENTHUB_VERSION 注入后透出（部署写入 git sha）', async () => {
    process.env.AGENTHUB_VERSION = 'abc1234'
    const report = await new HealthService(db(true)).check(null)
    expect(report.version).toBe('abc1234')
    delete process.env.AGENTHUB_VERSION
  })
})
