/**
 * 真实 PostgreSQL 集成测试（P3 方案书 §7 性能项：resolveToken p95 1000 次 ≤ 5ms）。
 *
 * 沿用 P2 D9 模式：经 AGENTHUB_TEST_DATABASE_URL 连本机 PostgreSQL（未设置时整组
 * 跳过），要求迁移 0010 已应用。user_credentials 对 users / system_connections 有
 * 外键，故先建临时 user + connection，末了按依赖序清理。
 *
 * @module tests/integration.spec
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Queryable } from '@agenthub/_shared'
import { CredentialVaultService } from '../src/index.ts'

const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL
const CALLS = 1000

/** Base64(32 字节) 测试主密钥（secrets.md §2.1 格式）。 */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')

describe.skipIf(integrationUrl === undefined)('user_credentials 解密时延（§7 性能）', () => {
  it('resolveToken p95 ≤ 5ms（1000 次采样）', { timeout: 120_000 }, async () => {
    const pool = new Pool({ connectionString: integrationUrl })
    const email = `perf-${randomUUID()}@agenthub.local`
    let userId = ''
    let connectionId = ''
    try {
      const db = pool as unknown as Queryable
      const users = await pool.query<{ id: string }>(
        'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [email, 'perf', 'x'],
      )
      userId = users.rows[0]?.id ?? ''
      const conns = await pool.query<{ id: string }>(
        'INSERT INTO system_connections (name, base_url, auth_mode, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        ['perf', 'http://perf.local', 'pat', userId],
      )
      connectionId = conns.rows[0]?.id ?? ''

      const service = new CredentialVaultService(db, { masterKey: MASTER_KEY })
      await service.storeCredential({ userId, systemConnectionId: connectionId, plaintext: 'perf-secret' })

      const samples: number[] = []
      for (let index = 0; index < CALLS; index += 1) {
        const start = performance.now()
        await service.resolveToken(userId, connectionId)
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      const p95 = samples[Math.ceil(CALLS * 0.95) - 1] ?? Number.POSITIVE_INFINITY
      console.log(`resolveToken p95 = ${p95.toFixed(3)}ms（${CALLS} 次）`)
      expect(p95).toBeLessThanOrEqual(5)
    } finally {
      if (connectionId !== '') await pool.query('DELETE FROM system_connections WHERE id = $1', [connectionId])
      if (userId !== '') await pool.query('DELETE FROM users WHERE id = $1', [userId])
      await pool.end()
    }
  })
})
