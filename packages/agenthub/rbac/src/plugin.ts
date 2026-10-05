/**
 * Cordis 插件入口（plugin-skeleton §2.1）。
 *
 * @module @agenthub/rbac/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { createLogger, type Queryable } from '@agenthub/_shared'
import { RbacService } from './service.ts'

export const name = '@agenthub/rbac' as const

/** 静态依赖元数据（loader 读取）；运行时以 ctx.inject 真正门禁。 */
export const inject = ['agenthub/db', 'agenthub/auth'] as const

/** 注册顺序（plugin-skeleton §3）：rbac 依赖 auth/db（查询用户身份），必须在其后。 */
export function apply(ctx: Context): void {
  ctx.inject(['agenthub/db', 'agenthub/auth'], (injected) => {
    ctx.provide(
      'agenthub/rbac',
      new RbacService({
        db: injected.get('agenthub/db') as Queryable,
        logger: createLogger('agenthub/rbac'),
      }),
    )
  })
}
