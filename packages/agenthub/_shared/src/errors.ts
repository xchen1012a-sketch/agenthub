/**
 * 错误处理约定（.ai-spec 40-extension.md EXT-9 / .ai-spec 40-extension.md EXT-9）。
 *
 * ✅ MUST：业务错误一律抛 AgenthubError，code 形如 `agenthub/<pkg>/<ErrorClass>`
 * （如 `agenthub/auth/InvalidCredential`），禁止裸 `new Error()` 抛业务错误。
 *
 * @module @agenthub/_shared/errors
 */
import { redactText } from './redact.ts'

/** code 格式 MUST 校验：<package> 为 agenthub 包 slug（含 _shared 的下划线前缀），<ErrorClass> 为大写驼峰类名。 */
const ERROR_CODE_RE = /^agenthub\/[a-z_][a-z0-9_-]*\/[A-Z][A-Za-z0-9]*$/

export interface AgenthubErrorOptions {
  /** HTTP 状态码与 code 解耦（REST 语义 401/403/404/409/500），默认 500。 */
  httpStatus?: number
  cause?: unknown
}

export class AgenthubError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, message: string, options: AgenthubErrorOptions = {}) {
    // 内部不变量（非业务错误）：code 格式在构造期即拦截，防止 §5.1 MUST 被绕过。
    if (!ERROR_CODE_RE.test(code)) {
      throw new Error(
        `AgenthubError code 必须形如 agenthub/<pkg>/<ErrorClass>，收到 "${code}"`,
      )
    }
    super(redactText(message))
    this.name = 'AgenthubError'
    this.code = code
    this.httpStatus = options.httpStatus ?? 500
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export function isAgenthubError(value: unknown): value is AgenthubError {
  return value instanceof AgenthubError
}

/** U5 错误响应 envelope；可空字段统一 null（.ai-spec 40-extension.md EXT-7 MUST）。 */
export interface ErrorEnvelope {
  code: string
  message: string
  traceId: string | null
}

/**
 * 任意 throw 值 → HTTP envelope：
 * - AgenthubError：透出 code / message（构造期已脱敏）；
 * - 其他错误：fail-closed，不外泄第三方 message / 堆栈细节。
 */
export function toErrorEnvelope(error: unknown, traceId: string | null): ErrorEnvelope {
  if (isAgenthubError(error)) {
    return { code: error.code, message: error.message, traceId }
  }
  return {
    code: 'agenthub/_shared/UnknownError',
    message: '内部错误，请联系管理员',
    traceId,
  }
}
