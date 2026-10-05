import { describe, expect, it, vi } from 'vitest'
import {
  AgenthubError,
  createLogger,
  jsonLineSink,
  levelFromEnv,
  type LogInput,
  type LogRecord,
} from '../src/index.ts'

const input: LogInput = {
  event: 'project.created',
  projectId: null,
  userId: 'user-1',
  traceId: '0f0e0d0c-0b0a-4998-8998-0f0e0d0c0b0a',
  sessionId: null,
}

function capture(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = []
  return { records, sink: record => records.push(record) }
}

describe('U3 八字段日志（OBS-2）', () => {
  it('每条日志包含全部八字段且值正确', () => {
    const { records, sink } = capture()
    const logger = createLogger('@agenthub/test', {
      sink,
      now: () => '2026-09-27T00:00:00.000Z',
    })
    logger.info(input)

    const record = records[0]
    if (!record) throw new Error('期望产出一条日志')
    expect(record).toEqual({
      level: 'info',
      ts: '2026-09-27T00:00:00.000Z',
      event: 'project.created',
      project_id: null,
      user_id: 'user-1',
      trace_id: '0f0e0d0c-0b0a-4998-8998-0f0e0d0c0b0a',
      session_id: null,
      package: '@agenthub/test',
    })
    expect(Object.keys(record).sort()).toEqual([
      'event',
      'level',
      'package',
      'project_id',
      'session_id',
      'trace_id',
      'ts',
      'user_id',
    ])
  })

  it('必填上下文缺失（undefined）即抛 LogFieldMissing——缺一即单测 fail', () => {
    const { sink } = capture()
    const logger = createLogger('@agenthub/test', { sink })
    const broken = { ...input, sessionId: undefined } as unknown as LogInput

    expect(() => {
      logger.info(broken)
    }).toThrow(AgenthubError)
    expect(() => {
      logger.info(broken)
    }).toThrow(/sessionId/)
  })

  it('四个级别均产出对应 level 字段', () => {
    const { records, sink } = capture()
    const logger = createLogger('@agenthub/test', { sink, now: () => 'ts', level: 'debug' })
    logger.debug(input)
    logger.info(input)
    logger.warn(input)
    logger.error(input)

    expect(records.map(record => record.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('低于阈值的级别被丢弃（level 语义与 AGENTHUB_LOG_LEVEL 对齐）', () => {
    const { records, sink } = capture()
    const logger = createLogger('@agenthub/test', { sink, level: 'warn' })
    logger.debug(input)
    logger.info(input)
    logger.warn(input)
    logger.error(input)

    expect(records.map(record => record.level)).toEqual(['warn', 'error'])
  })

  it('data 附属字段落 sink 前强制脱敏（V5 预热）', () => {
    const { records, sink } = capture()
    const logger = createLogger('@agenthub/test', { sink })
    logger.info(input, { password: 'p@ss', nested: { token: 't0k' }, keep: 'v' })

    const record = records[0]
    if (!record) throw new Error('期望产出一条日志')
    expect(record.data).toEqual({ password: '***', nested: { token: '***' }, keep: 'v' })
  })

  it('data 缺省时不产出 data 字段（非 undefined 占位）', () => {
    const { records, sink } = capture()
    const logger = createLogger('@agenthub/test', { sink })
    logger.info(input)

    const record = records[0]
    if (!record) throw new Error('期望产出一条日志')
    expect('data' in record).toBe(false)
  })

  it('levelFromEnv 对齐 AGENTHUB_LOG_LEVEL，非法值回退 info', () => {
    expect(levelFromEnv({})).toBe('info')
    expect(levelFromEnv({ AGENTHUB_LOG_LEVEL: 'debug' })).toBe('debug')
    expect(levelFromEnv({ AGENTHUB_LOG_LEVEL: 'warn' })).toBe('warn')
    expect(levelFromEnv({ AGENTHUB_LOG_LEVEL: 'error' })).toBe('error')
    expect(levelFromEnv({ AGENTHUB_LOG_LEVEL: 'verbose' })).toBe('info')
  })

  it('未显式传 level 时使用 AGENTHUB_LOG_LEVEL', () => {
    const previous = process.env.AGENTHUB_LOG_LEVEL
    process.env.AGENTHUB_LOG_LEVEL = 'error'
    try {
      const { records, sink } = capture()
      const logger = createLogger('@agenthub/test', { sink })
      logger.info(input)
      logger.error(input)
      expect(records.map(record => record.level)).toEqual(['error'])
    } finally {
      if (previous === undefined) delete process.env.AGENTHUB_LOG_LEVEL
      else process.env.AGENTHUB_LOG_LEVEL = previous
    }
  })

  it('默认 sink 输出 JSON 行到 stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const record: LogRecord = {
        level: 'info',
        ts: '2026-09-27T00:00:00.000Z',
        event: input.event,
        project_id: input.projectId,
        user_id: input.userId,
        trace_id: input.traceId,
        session_id: input.sessionId,
        package: '@agenthub/test',
      }
      jsonLineSink(record)
      const first = write.mock.calls[0]
      if (!first) throw new Error('期望一次 stdout 写入')
      const parsed = JSON.parse(String(first[0])) as LogRecord
      expect(parsed.event).toBe('project.created')
      expect(parsed.trace_id).toBe(input.traceId)
    } finally {
      write.mockRestore()
    }
  })
})
