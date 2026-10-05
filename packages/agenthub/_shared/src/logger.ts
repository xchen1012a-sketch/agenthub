/**
 * U3 八字段结构化日志（.ai-spec 40-extension.md EXT-7，OBS-2）。
 *
 * 每条业务日志必须含：level / ts / event / project_id / user_id / trace_id /
 * session_id / package 八字段；可空字段显式写 null，缺一即构造期抛错（OBS-2 单测守护）。
 * data 附属字段落 sink 前强制过 redact（V5）。
 *
 * @module @agenthub/_shared/logger
 */
import { AgenthubError } from './errors.ts'
import { redact } from './redact.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 日志调用方必须显式给出全部上下文；无值传 null（不可省略键）。 */
export interface LogInput {
  /** 动词短语，如 project.created / tool.before-execute。 */
  event: string
  projectId: string | null
  userId: string | null
  traceId: string | null
  sessionId: string | null
}

/** U3 最小字段集（snake_case 与 .ai-spec 40-extension.md EXT-7 表格一致）。 */
export interface LogRecord {
  level: LogLevel
  /** ISO 8601。 */
  ts: string
  event: string
  project_id: string | null
  user_id: string | null
  trace_id: string | null
  session_id: string | null
  /** 发出日志的 @agenthub/* 包名。 */
  package: string
  data?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

/** 默认 sink：JSON 行写 stdout（结构化输出，禁止裸 console.log 文本）。 */
export function jsonLineSink(record: LogRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

const REQUIRED_INPUT_KEYS = ['event', 'projectId', 'userId', 'traceId', 'sessionId'] as const

export interface LoggerOptions {
  /** 低于该级别的日志丢弃；未指定时读取 AGENTHUB_LOG_LEVEL，非法值回退 info。 */
  level?: LogLevel
  sink?: LogSink
  /** 时间源（测试注入用）；默认 Date#toISOString。 */
  now?: () => string
}

export interface Logger {
  readonly package: string
  debug(input: LogInput, data?: Record<string, unknown>): void
  info(input: LogInput, data?: Record<string, unknown>): void
  warn(input: LogInput, data?: Record<string, unknown>): void
  error(input: LogInput, data?: Record<string, unknown>): void
}

/** 读取 AGENTHUB_LOG_LEVEL（.ai-spec 40-extension.md EXT-7 level 对齐约定）；非法值回退 'info'。 */
export function levelFromEnv(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = env.AGENTHUB_LOG_LEVEL
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

export function createLogger(pkg: string, options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[options.level ?? levelFromEnv()]
  const sink = options.sink ?? jsonLineSink
  const now = options.now ?? (() => new Date().toISOString())

  const emit = (level: LogLevel, input: LogInput, data?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < threshold) return
    // 运行时契约守护：类型层必填不保证调用方真的传了（JS 边界 / as 断言绕过），
    // OBS-2 MUST 要求缺字段即拦截，故对宽松 bag 视图逐键检查。
    const bag = input as Record<keyof LogInput, string | null | undefined>
    for (const key of REQUIRED_INPUT_KEYS) {
      if (bag[key] === undefined) {
        throw new AgenthubError(
          'agenthub/_shared/LogFieldMissing',
          `日志缺少必填字段 ${key}（无值必须显式传 null）`,
        )
      }
    }
    const record: LogRecord = {
      level,
      ts: now(),
      event: input.event,
      project_id: input.projectId,
      user_id: input.userId,
      trace_id: input.traceId,
      session_id: input.sessionId,
      package: pkg,
    }
    if (data !== undefined) record.data = redact(data) as Record<string, unknown>
    sink(record)
  }

  return {
    package: pkg,
    debug: (input, data) => {
      emit('debug', input, data)
    },
    info: (input, data) => {
      emit('info', input, data)
    },
    warn: (input, data) => {
      emit('warn', input, data)
    },
    error: (input, data) => {
      emit('error', input, data)
    },
  }
}
