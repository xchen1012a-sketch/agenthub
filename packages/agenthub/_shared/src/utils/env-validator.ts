/**
 * 敏感环境变量集中校验（secrets.md §4 MUST）。
 *
 * ✅ MUST（secrets.md §4）：AgentHub 启动时校验
 * - 所有「必填」敏感变量已设置（secrets.md §1.1）；
 * - `AGENTHUB_VAULT_MASTER_KEY` Base64 解码后恰好 32 字节；
 * - `AGENTHUB_DB_URL` 可被解析（postgres / postgresql 连接串）。
 *
 * 任一失败即抛 AgenthubError（fail-fast），调用方（插件装配期）不静默降级。
 * 校验只读环境变量，不接受明文写入任何日志 / 事件。
 *
 * @module @agenthub/_shared/utils/env-validator
 */
import { AgenthubError } from '../errors.ts'

/** 环境变量读取面（兼容 process.env 与测试注入的普通对象）。 */
export type EnvLike = Record<string, string | undefined>

/** 主密钥变量名（secrets.md §1.1）。 */
export const VAULT_MASTER_KEY_VAR = 'AGENTHUB_VAULT_MASTER_KEY' as const

/** 数据库连接串变量名（secrets.md §1.1）。 */
export const DB_URL_VAR = 'AGENTHUB_DB_URL' as const

/** AES-256 主密钥字节数（secrets.md §2.1 MUST）。 */
export const MASTER_KEY_BYTES = 32

/**
 * secrets.md §1.1 中「必填 = 是」的敏感变量集合。
 * `AGENTHUB_DB_PASSWORD` 为条件必填（仅当 URL 含占位符），不在此列。
 */
export const REQUIRED_SENSITIVE_ENV_VARS: readonly string[] = [
  VAULT_MASTER_KEY_VAR,
  DB_URL_VAR,
  'AGENTHUB_LLM_API_KEY',
  'AGENTHUB_COOKIE_SECRET',
]

/** 是否未设置（undefined 或纯空白）。 */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * 校验主密钥：非空且 Base64 解码后恰好 32 字节（secrets.md §2.1 MUST），
 * 返回解码后的密钥字节（供调用方复用，避免二次解码）。
 */
export function validateMasterKey(env: EnvLike, varName: string = VAULT_MASTER_KEY_VAR): Buffer {
  const raw = env[varName]
  if (raw === undefined || isBlank(raw)) {
    throw new AgenthubError(
      'agenthub/_shared/EnvMasterKeyMissing',
      `${varName} 未设置；用 openssl rand -base64 32 生成并经环境变量注入（secrets.md §1.1）`,
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== MASTER_KEY_BYTES) {
    throw new AgenthubError(
      'agenthub/_shared/EnvMasterKeyInvalid',
      `${varName} Base64 解码后必须为 ${MASTER_KEY_BYTES} 字节，实际 ${key.length} 字节；请重新生成`,
    )
  }
  return key
}

/**
 * 校验数据库连接串：非空且可解析为 postgres / postgresql 协议（secrets.md §4 MUST）。
 * 返回原始连接串，便于调用方直接建池。
 */
export function validateDbUrl(env: EnvLike, varName: string = DB_URL_VAR): string {
  const raw = env[varName]
  if (raw === undefined || isBlank(raw)) {
    throw new AgenthubError(
      'agenthub/_shared/EnvDbUrlMissing',
      `${varName} 未设置；参考 deploy/.env.example（secrets.md §1.1）`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new AgenthubError(
      'agenthub/_shared/EnvDbUrlInvalid',
      `${varName} 无法解析为合法连接串`,
      { cause: error },
    )
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new AgenthubError(
      'agenthub/_shared/EnvDbUrlInvalid',
      `${varName} 协议必须为 postgres:// 或 postgresql://，实际 ${parsed.protocol}`,
    )
  }
  return raw
}

/**
 * 集中校验入口（secrets.md §4 MUST）：必填敏感变量已设置 + 主密钥长度 + DB URL 可解析。
 * 任一不满足即抛 AgenthubError（fail-fast），调用方（启动入口）不得吞错降级。
 */
export function validateEnv(env: EnvLike): void {
  const missing = REQUIRED_SENSITIVE_ENV_VARS.filter(name => isBlank(env[name]))
  if (missing.length > 0) {
    throw new AgenthubError(
      'agenthub/_shared/EnvMissing',
      `缺少必填敏感环境变量：${missing.join(', ')}（secrets.md §1.1）`,
    )
  }
  validateMasterKey(env)
  validateDbUrl(env)
}
