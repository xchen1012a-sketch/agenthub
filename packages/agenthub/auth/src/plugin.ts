/**
 * Cordis 插件入口（plugin-skeleton §2.1：命名导出 apply，name 与 npm 名一致）。
 *
 * @module @agenthub/auth/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { AGENTHUB_EVENTS, createAgenthubPool, type UserAuthenticatedPayload } from '@agenthub/_shared'
import { AuthService } from './service.ts'

export const name = '@agenthub/auth' as const

// 事件面声明合并（上游约定：typed events 用 declaration merging）。
declare module '@deepseek-ai/cordis' {
  interface Events {
    [AGENTHUB_EVENTS.userAuthenticated](payload: UserAuthenticatedPayload): void
  }
}

/**
 * 注册顺序（plugin-skeleton §3）：auth 是安全层第一个插件，无上游依赖。
 * 全进程唯一 pg Pool 在此创建并以 `agenthub/db` provide（_shared/db.ts 约定）；
 * 插件卸载时经 ctx.effect 关闭，连接不泄漏。
 */
export function apply(ctx: Context): void {
  const db = createAgenthubPool()
  ctx.provide('agenthub/db', db)
  ctx.provide(
    'agenthub/auth',
    new AuthService({
      db,
      onAuthenticated: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.userAuthenticated, payload)
      },
    }),
  )
  ctx.effect(() => () => void db.end())
}
