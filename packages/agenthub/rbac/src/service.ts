/**
 * 守卫服务（阶段书 §3.1 #9 / §4.1 #5）。
 *
 * 平台级守卫仅看 roles；Project 级守卫查 project_members + users.status='active'
 * （database-schema §3.2），身份一律来自 @agenthub/auth 服务端解析（A6）。
 *
 * @module @agenthub/rbac/service
 */
import { AgenthubError, type Logger, type UserId } from '@agenthub/_shared'
import type { Queryable } from '@agenthub/_shared'
import { DEV_USER_ID, type AuthUser } from '@agenthub/auth'

/** 守卫入参：任何带 roles 集合的身份视角（与 AuthUser 结构最小相交）。 */
export interface RbacUser {
  readonly userId: UserId
  readonly roles: readonly string[]
}

/** 从 AuthUser 视角收窄（避免跨包泄漏 AuthUser 完整结构）。 */
export function asRbacUser(user: AuthUser): RbacUser {
  return { userId: user.userId, roles: user.roles }
}

export class RbacService {
  constructor(private readonly options: { db?: Queryable; logger?: Logger } = {}) {}

  private get logger(): Logger | undefined {
    return this.options.logger
  }

  private deny(user: RbacUser | null, guard: string, traceId: string | null, message: string, projectId: string | null = null): never {
    this.logger?.warn(
      {
        event: 'rbac.denied',
        projectId,
        userId: user === null ? null : user.userId,
        traceId,
        sessionId: null,
      },
      { guard },
    )
    throw new AgenthubError('agenthub/rbac/Forbidden', message, { httpStatus: 403 })
  }

  /**
   * 平台管理员守卫（fail-closed，.ai-spec 20-security.md BND-3）。
   * @param traceId 请求级 traceId（OBS-1：拒绝日志可关联到具体请求）。
   * @throws AgenthubError `agenthub/rbac/Forbidden`（403）非 platform_admin 时。
   */
  requirePlatformAdmin(user: RbacUser | null, traceId: string | null): void {
    if (user === null || !user.roles.includes('platform_admin')) {
      this.deny(user, 'requirePlatformAdmin', traceId, '需要平台管理员权限')
    }
  }

  /**
   * Project 成员守卫：project_members 行存在且 users.status='active'。
   * @returns 成员角色（admin / member / approver），供调用方做细粒度分支。
   * @throws AgenthubError `agenthub/rbac/Forbidden`（403）非成员或账号停用时。
   */
  async requireProjectMember(user: RbacUser | null, projectId: string, traceId: string | null): Promise<'admin' | 'member' | 'approver'> {
    const role = await this.memberRole(user, projectId)
    if (role === null) this.deny(user, 'requireProjectMember', traceId, '你不是该 Project 的成员', projectId)
    return role
  }

  /**
   * Project 管理员守卫：requireProjectMember 且角色为 admin。
   * @throws AgenthubError `agenthub/rbac/Forbidden`（403）。
   */
  async requireProjectAdmin(user: RbacUser | null, projectId: string, traceId: string | null): Promise<'admin'> {
    const role = await this.memberRole(user, projectId)
    if (role !== 'admin') {
      this.deny(user, 'requireProjectAdmin', traceId, '需要该 Project 的管理员权限', projectId)
    }
    return 'admin'
  }

  /** 成员角色查询；无 db 句柄（单测形态）或非成员返回 null（fail-closed）。 */
  private async memberRole(user: RbacUser | null, projectId: string): Promise<'admin' | 'member' | 'approver' | null> {
    const db = this.options.db
    if (user === null || db === undefined) return null
    const found = await db.query<{ role: 'admin' | 'member' | 'approver' }>(
      `SELECT pm.role FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND pm.user_id = $2 AND u.status = 'active'`,
      [projectId, user.userId],
    )
    return found.rows[0]?.role ?? null
  }
}

/** dev 匿名用户便捷视角（P1：固定 platform_admin）。 */
export const DEV_RBAC_USER: RbacUser = { userId: DEV_USER_ID, roles: ['platform_admin'] }
