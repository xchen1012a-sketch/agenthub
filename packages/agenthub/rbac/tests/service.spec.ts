import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import { asUserId } from '@agenthub/_shared'
import { asRbacUser, DEV_RBAC_USER, RbacService } from '../src/index.ts'
import type { AuthUser } from '@agenthub/auth'

describe('RbacService.requirePlatformAdmin（阶段书 §3.1 #9）', () => {
  const rbac = new RbacService()

  it('platform_admin 通过', () => {
    expect(() => {
      rbac.requirePlatformAdmin(DEV_RBAC_USER, null)
    }).not.toThrow()
  })

  it('普通成员被拒（403，fail-closed）', () => {
    try {
      rbac.requirePlatformAdmin({ userId: asUserId('u-1'), roles: ['member'] }, null)
      expect.unreachable('必须抛错')
    } catch (error) {
      expect((error as { code: string }).code).toBe('agenthub/rbac/Forbidden')
      expect((error as { httpStatus: number }).httpStatus).toBe(403)
    }
  })

  it('无身份（null）fail-closed', () => {
    try {
      rbac.requirePlatformAdmin(null, '0197efc8-1a2b-4c3d-8e4f-5a6b7c8d9e0f')
      expect.unreachable('必须抛错')
    } catch (error) {
      expect((error as { code: string }).code).toBe('agenthub/rbac/Forbidden')
    }
  })

  it('asRbacUser 收窄 AuthUser 而不泄漏 displayName', () => {
    const authUser: AuthUser = {
      userId: asUserId('00000000-0000-4000-8000-000000000001'),
      displayName: 'Dev Admin',
      roles: ['platform_admin'],
    }
    const view = asRbacUser(authUser)
    expect(view.roles).toEqual(['platform_admin'])
    expect('displayName' in view).toBe(false)
  })
})

describe('RbacService.requireProjectMember / requireProjectAdmin（阶段书 §4.1 #5）', () => {
  const USER = { userId: asUserId('u-1'), roles: ['member'] }
  const PROJECT = '00000000-0000-4000-8000-0000000000a1'

  function rbacWith(rows: { role: 'admin' | 'member' | 'approver' }[]) {
    const calls: { text: string; values: readonly unknown[] }[] = []
    const rbac = new RbacService({
      db: {
        async query<R extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<R>, 'rows'>> {
          calls.push({ text, values: values ?? [] })
          return { rows: rows as unknown as R[] }
        },
      },
    })
    return { rbac, calls }
  }

  it('active 成员通过 requireProjectMember 并拿到角色', async () => {
    const { rbac, calls } = rbacWith([{ role: 'member' }])
    const role = await rbac.requireProjectMember(USER, PROJECT, 'tid-1')
    expect(role).toBe('member')
    expect(calls[0]?.text).toContain('u.status = ')
    expect(calls[0]?.values).toEqual([PROJECT, USER.userId])
  })

  it('非成员 403（fail-closed）', async () => {
    const { rbac } = rbacWith([])
    const error = await rbac.requireProjectMember(USER, PROJECT, null).catch((e: unknown) => e)
    expect((error as { code: string }).code).toBe('agenthub/rbac/Forbidden')
    expect((error as { httpStatus: number }).httpStatus).toBe(403)
  })

  it('无 db 句柄 fail-closed 403（构造期缺依赖不允许放行）', async () => {
    const rbac = new RbacService()
    const error = await rbac.requireProjectMember(USER, PROJECT, null).catch((e: unknown) => e)
    expect((error as { httpStatus: number }).httpStatus).toBe(403)
  })

  it('admin 通过 requireProjectAdmin；普通成员被拒', async () => {
    const ok = rbacWith([{ role: 'admin' }])
    expect(await ok.rbac.requireProjectAdmin(USER, PROJECT, null)).toBe('admin')

    const denied = rbacWith([{ role: 'member' }])
    const error = await denied.rbac.requireProjectAdmin(USER, PROJECT, null).catch((e: unknown) => e)
    expect((error as { code: string }).code).toBe('agenthub/rbac/Forbidden')
  })

  it('null 身份 fail-closed 403', async () => {
    const { rbac } = rbacWith([{ role: 'admin' }])
    const error = await rbac.requireProjectMember(null, PROJECT, null).catch((e: unknown) => e)
    expect((error as { httpStatus: number }).httpStatus).toBe(403)
  })
})
