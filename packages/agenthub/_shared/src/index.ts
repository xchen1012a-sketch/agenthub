/**
 * @agenthub/_shared —— AgentHub 插件包共享基础设施。
 *
 * 职责（阶段书 P1 #7/#14）：
 * - trace-id.ts：TraceId 生命周期（OBS-1）
 * - logger.ts：U3 八字段结构化日志（OBS-2）
 * - redact.ts：凭证脱敏（V5）
 * - errors.ts：AgenthubError + U5 错误 envelope（plugin-skeleton §5）
 * - events.ts：v1 核心八事件名与 Payload 类型（events-bus §2）
 * - types.ts：全域 branded 标识类型
 * - utils/env-validator.ts：敏感环境变量集中校验（.ai-spec 20-security.md SEC-7）
 * - host-guard.ts：出站目标安全判定与显式白名单（C-4，唯一实现）
 *
 * 依赖方向：仅依赖上游 @deepseek-ai/dsh-brand（类型层）；所有 @agenthub/* 包 → 本包，禁止反向。
 *
 * @module @agenthub/_shared
 */
export * from './types.ts'
export * from './trace-id.ts'
export * from './redact.ts'
export * from './errors.ts'
export * from './logger.ts'
export * from './events.ts'
export * from './http.ts'
export * from './host-guard.ts'
export * from './db.ts'
export * from './constants.ts'
export * from './utils/env-validator.ts'
export * from './utils/llm-client.ts'
