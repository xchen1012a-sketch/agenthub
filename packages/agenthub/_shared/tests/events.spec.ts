import { describe, expect, it } from 'vitest'
import { AGENTHUB_EVENTS } from '../src/index.ts'

describe('事件总线契约（.ai-spec 40-extension.md EXT-5+EXT-6）', () => {
  it('v1 核心八事件 + P3 补充三事件 + P4 memory.candidate 全部存在（方案书 D10 / 阶段 C D16 / 阶段 B T4）', () => {
    expect(Object.keys(AGENTHUB_EVENTS)).toHaveLength(12)
    expect(AGENTHUB_EVENTS.approvalResolved).toBe('agenthub/approval.resolved')
    expect(AGENTHUB_EVENTS.credentialExpired).toBe('agenthub/credential.expired')
    expect(AGENTHUB_EVENTS.toolDenied).toBe('agenthub/tool.denied')
    expect(AGENTHUB_EVENTS.memoryCandidate).toBe('agenthub/memory.candidate')
  })

  it('事件名一律带 agenthub/ 前缀且符合 <domain>.<verb-past> 形式', () => {
    for (const name of Object.values(AGENTHUB_EVENTS)) {
      expect(name.startsWith('agenthub/'), `${name} 缺少 agenthub/ 前缀`).toBe(true)
      expect(name, `${name} 不符合 <domain>.<verb-past> 形式`).toMatch(
        /^agenthub\/[a-z-]+\.[a-z-]+$/,
      )
    }
  })

  it('事件名不被静默改名（token-resolved 禁带 token，拼写锁定）', () => {
    expect(AGENTHUB_EVENTS.externalSystemTokenResolved).toBe(
      'agenthub/external-system.token-resolved',
    )
  })
})
