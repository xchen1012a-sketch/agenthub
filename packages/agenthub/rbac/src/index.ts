/**
 * @agenthub/rbac —— 平台角色与成员关系。
 *
 * P1 范围（阶段书 §3.1 #9）：仅 `requirePlatformAdmin` 守卫。
 * Project 级成员校验由 @agenthub/project 的 resolveProjectContext 承担（P1），
 * 本包在 P2 扩展 user_roles 表查询。
 *
 * @module @agenthub/rbac
 */
export { RbacService, asRbacUser, DEV_RBAC_USER, type RbacUser } from './service.ts'
export { name, apply } from './plugin.ts'
