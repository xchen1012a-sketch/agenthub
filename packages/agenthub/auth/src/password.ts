/**
 * Argon2id 密码摘要（security.md / .ai-spec 30-data.md DATA-1：users.password_hash 为 Argon2id）。
 *
 * @module @agenthub/auth/password
 */
import { hash, verify } from '@node-rs/argon2'

/** Argon2id 参数：OWASP 推荐基线（19MiB 内存 / 2 迭代 / 1 并行度）。 */
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

/** 生成 Argon2id 摘要（PHC 字符串，直接落 users.password_hash）。 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS)
}

/** 校验密码与摘要是否匹配；摘要格式非法时返回 false（fail-closed，不抛）。 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}
