/**
 * @agenthub/health —— 健康检查（阶段书 §3.1 #13）。
 *
 * GET /healthz → 200 `{"status":"ok","version":"<sha>","db":"ok"}`（V1）；
 * DB 探活失败 → 503 `{"status":"degraded","db":"error"}`（fail-closed）。
 *
 * @module @agenthub/health
 */
export { HealthService } from './service.ts'
export type { Queryable } from './db.ts'
export { name, apply, inject, HEALTHZ_PATH } from './plugin.ts'
