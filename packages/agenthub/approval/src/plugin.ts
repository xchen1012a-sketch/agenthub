/**
 * Cordis 插件入口（plugin-skeleton §2.1 / P3 方案书阶段 B T4）。
 *
 * 装配流程：
 * 1. 启动校验 + 孤儿清理（failClosed=true 时失败即启动失败）；
 * 2. `tools/pre-execute` waterfall：按 tools 表策略字段返回 ask（须送审）或
 *    next() 透传（放行）——是否送审由字段决定，不由模型决定（security.md §2.1）；
 * 3. `approval/request` waterfall：非本包发起的 ask next() 交还链上其他
 *    answerer（T0 Spike 结论：AgentHub listener 于启动期注册，先于按连接
 *    动态注册的 remote 桥 answerer，claim 后对话内上游审批卡不出现，管理台
 *    为唯一决策通道，D7 不动 occupant）；
 * 4. provide `agenthub/approval`（ui 包 JSON API 消费）。
 *
 * @module @agenthub/approval/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { AGENTHUB_EVENTS, createLogger, type Queryable } from '@agenthub/_shared'
import type { SessionToolScopeService } from '@agenthub/project-tool-scope'
import { PgApprovalToolCatalog } from './catalog.ts'
import { shouldAsk, type MinRiskLevel } from './policy.ts'
import { ApprovalGateService, type ApprovalConfig } from './service.ts'

export const name = '@agenthub/approval' as const

/** 插件配置（agenthub.yaml agenthub.approval 段，§4.4 默认值）。 */
export interface Config {
  readonly failClosed: boolean
  readonly timeoutHours: number
  readonly minRiskLevel: MinRiskLevel
}

export const Config = z.object({
  failClosed: z.boolean().default(true),
  timeoutHours: z.number().default(1),
  minRiskLevel: z.union(['write', 'sensitive', 'critical'] as const).default('write'),
})

/**
 * 必需服务：共享 DB 连接（@agenthub/auth provide）+ Session Tool scope
 * （@agenthub/project-tool-scope provide：agent → Project 绑定，注册顺序在其后）。
 */
export const inject = ['agenthub/db', 'agenthub/tool-scope'] as const

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['agenthub/db', 'agenthub/tool-scope'], async (injected) => {
    const logger = createLogger('agenthub/approval')
    const pool = injected.get('agenthub/db') as Queryable
    const scopes = injected.get('agenthub/tool-scope') as SessionToolScopeService
    const catalog = new PgApprovalToolCatalog(pool)
    const gate: ApprovalConfig = {
      failClosed: config.failClosed,
      timeoutHours: config.timeoutHours,
      minRiskLevel: config.minRiskLevel,
    }
    const service = new ApprovalGateService(pool, gate, {
      onRequested: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.approvalRequested, payload)
      },
      onResolved: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.approvalResolved, payload)
      },
      // 审批方向阻断（no_approver / approval_rejected / approval_expired）→
      // audit 置 denied + result_meta.reason（阶段 C T8 / D16）。
      onDenied: (payload) => {
        ctx.emit(AGENTHUB_EVENTS.toolDenied, payload)
      },
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      const handle = scopes.bindingOf(exec.agent)
      if (handle === null) return next()
      const facts = await catalog.toolFacts(exec.name)
      if (facts === null || !shouldAsk(facts, config.minRiskLevel)) return next()
      service.stageAsk(exec.callId, {
        toolId: facts.id,
        toolName: exec.name,
        riskLevel: facts.riskLevel,
        args: (exec.arguments ?? {}) as Record<string, unknown>,
        projectId: handle.binding.projectId,
        userId: handle.binding.userId,
        sessionId: handle.binding.sessionId,
      })
      const ask: PreToolDecision = {
        kind: 'ask',
        reason: `agenthub: tool "${exec.name}" (risk_level=${facts.riskLevel}) requires approval`,
      }
      return ask
    })

    ctx.on('approval/request', async (req, next) => {
      const staged = service.takeStaged(req.callId)
      if (staged === null) return next()
      // 透传上游取消信号：abort 时上游已按 cancelled 结算，AgentHub 侧须清理不残留。
      return await service.openApproval(staged, req.signal)
    })

    ctx.provide('agenthub/approval', service)
    // await：failClosed=true 校验失败在此抛出 → fiber 失败 → 启动失败（§4.1 fail-closed ③）。
    await service.start()
    logger.info({ event: 'plugin.started', projectId: null, userId: null, traceId: null, sessionId: null }, {})
  })
}
