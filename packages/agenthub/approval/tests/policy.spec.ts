/**
 * 策略判定（P3 方案书 §4.4 / 阶段 B 预期 4）。
 *
 * @module tests/policy.spec
 */
import { describe, expect, it } from 'vitest'
import { isMinRiskLevel, shouldAsk, toApprovalRiskLevel } from '../src/policy.ts'

describe('shouldAsk（策略 allow/ask 判定）', () => {
  it('requires_approval=true → 无论风险级别一律 ask', () => {
    expect(shouldAsk({ requiresApproval: true, riskLevel: 'read' }, 'write')).toBe(true)
    expect(shouldAsk({ requiresApproval: true, riskLevel: 'critical' }, 'critical')).toBe(true)
  })

  it('requires_approval=false 且 risk_level < minRiskLevel → allow', () => {
    expect(shouldAsk({ requiresApproval: false, riskLevel: 'read' }, 'write')).toBe(false)
    expect(shouldAsk({ requiresApproval: false, riskLevel: 'write' }, 'sensitive')).toBe(false)
  })

  it('risk_level ≥ minRiskLevel → ask', () => {
    expect(shouldAsk({ requiresApproval: false, riskLevel: 'write' }, 'write')).toBe(true)
    expect(shouldAsk({ requiresApproval: false, riskLevel: 'critical' }, 'write')).toBe(true)
  })

  it('未知 risk_level 视为 critical（fail-closed）→ ask', () => {
    expect(shouldAsk({ requiresApproval: false, riskLevel: 'unknown' }, 'write')).toBe(true)
  })

  it('isMinRiskLevel 值域校验', () => {
    expect(isMinRiskLevel('write')).toBe(true)
    expect(isMinRiskLevel('critical')).toBe(true)
    expect(isMinRiskLevel('read')).toBe(false)
    expect(isMinRiskLevel('bogus')).toBe(false)
  })

  it('toApprovalRiskLevel：read→write（approvals CHECK 不含 read），其余原样，未知→critical', () => {
    expect(toApprovalRiskLevel('read')).toBe('write')
    expect(toApprovalRiskLevel('write')).toBe('write')
    expect(toApprovalRiskLevel('sensitive')).toBe('sensitive')
    expect(toApprovalRiskLevel('critical')).toBe('critical')
    expect(toApprovalRiskLevel('unknown')).toBe('critical')
  })
})
