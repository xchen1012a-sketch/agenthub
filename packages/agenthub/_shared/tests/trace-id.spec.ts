import { describe, expect, it } from 'vitest'
import {
  TRACE_ID_KEY,
  createTraceId,
  getTraceId,
  isUuidV4,
  resolveTraceId,
} from '../src/index.ts'

describe('TraceId 生命周期（OBS-1）', () => {
  it('provide 键为 agenthub/traceId（.ai-spec 40-extension.md EXT-8）', () => {
    expect(TRACE_ID_KEY).toBe('agenthub/traceId')
  })

  it('缺失 / 空 header 生成 UUIDv4，且两次生成互不相同', () => {
    for (const missing of [null, undefined, '']) {
      const id = resolveTraceId(missing)
      expect(isUuidV4(id), `${String(missing)} 应兜底生成 UUIDv4`).toBe(true)
    }
    expect(resolveTraceId(null)).not.toBe(resolveTraceId(null))
  })

  it('合法 UUIDv4 header 原样采纳（header → ctx 同源）', () => {
    const header = '0f0e0d0c-0b0a-4998-8998-0f0e0d0c0b0a'
    expect(resolveTraceId(header)).toBe(header)
  })

  it('非法 header 一律重新生成', () => {
    const id = resolveTraceId('not-a-uuid')
    expect(isUuidV4(id)).toBe(true)
    expect(id).not.toBe('not-a-uuid')
  })

  it('isUuidV4 只接受 v4 版本位与合法 variant', () => {
    expect(isUuidV4('00000000-0000-1000-8000-000000000000')).toBe(false)
    expect(isUuidV4('00000000-0000-4000-c000-000000000000')).toBe(false)
    expect(isUuidV4('00000000-0000-4000-8000-000000000000')).toBe(true)
  })

  it('getTraceId：合法值原样读取，缺失 / 非法 / 非字符串一律 null（不允许 "null" 占位）', () => {
    const id = createTraceId()
    expect(isUuidV4(id)).toBe(true)
    expect(getTraceId({ [TRACE_ID_KEY]: id })).toBe(id)
    expect(getTraceId({})).toBeNull()
    expect(getTraceId({ [TRACE_ID_KEY]: 'garbage' })).toBeNull()
    expect(getTraceId({ [TRACE_ID_KEY]: 42 })).toBeNull()
  })
})
