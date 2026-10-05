/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P3 方案书阶段 A T3）。
 *
 * @module @agenthub/credential-vault/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { AGENTHUB_EVENTS, createLogger, validateEnv, type Queryable } from '@agenthub/_shared'
import { CredentialVaultService } from './service.ts'

export const name = '@agenthub/credential-vault' as const

/** 必需服务：共享 DB 连接（由 @agenthub/auth 以 `agenthub/db` provide）。 */
export const inject = ['agenthub/db'] as const

/**
 * 启动期敏感环境变量集中校验（secrets.md §4 MUST）：必填项已设置 +
 * `AGENTHUB_VAULT_MASTER_KEY` 解码 32 字节 + `AGENTHUB_DB_URL` 可解析，
 * 任一失败即抛错（fail-fast）。
 *
 * KEK 构造期校验（secrets.md §4 启动校验）：env 缺失/非法即抛错，
 * 插件装配失败 → 启动失败，不静默降级。
 */
export function apply(ctx: Context): void {
  validateEnv(process.env)
  ctx.inject(['agenthub/db'], (injected) => {
    const logger = createLogger('agenthub/credential-vault')
    const service = new CredentialVaultService(injected.get('agenthub/db') as Queryable, {
      masterKey: process.env.AGENTHUB_VAULT_MASTER_KEY,
      onCredentialExpired: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.credentialExpired, payload)
      },
    })
    ctx.provide('agenthub/vault', service)
    logger.info({ event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null }, {})
  })
}
