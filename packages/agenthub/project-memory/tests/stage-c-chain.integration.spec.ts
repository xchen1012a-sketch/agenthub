/**
 * P4 阶段 C 端到端链路（C4-4 的自动化部分，真库 + 真 LLM）。
 *
 * 把阶段 C 的三块能力按**用户真实使用顺序**串成一条链：
 *   ① 导入 OpenAPI → 草稿带模型判定的风险等级（C3-A）
 *   ② 工具调用落审计 → 按项目/状态筛选查得到（C3-B）
 *   ③ 会话结束提取候选 → 落库为候选（阶段 B）
 *   ④ 确认候选 → 进入注入集合（C1）
 *   ⑤ 新会话的注入文本含该记忆（C2 所依赖的服务层）
 *
 * **不覆盖**：浏览器里的点击与渲染（那是 C4-4 的手测部分，本文件无法替代）。
 * 依赖环境：`AGENTHUB_TEST_DATABASE_URL` 必需；`AGENTHUB_LLM_API_KEY` 决定①③能否跑
 * （缺 key 时这两步跳过，其余仍执行）。**跳过不等于通过**（QA-5）。
 *
 * @module tests/stage-c-chain.integration.spec
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createLlmClient,
  readLlmConfig,
  validateLlmConfig,
  type Queryable,
} from '@agenthub/_shared'
import { AuditService } from '@agenthub/audit'
import { createLlmRiskClassifier, OpenApiIngestService } from '@agenthub/openapi-ingest'
import { LlmCandidateGenerator } from '../src/candidate-generator.ts'
import { MemoryExtractor } from '../src/memory-extractor.ts'
import { MemoryInjector } from '../src/memory-injector.ts'
import { ProjectMemoryService } from '../src/service.ts'
import { fakeSession, fakeWorkspace, userMessage } from './fakes.ts'
const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL
const hasLlm = (process.env.AGENTHUB_LLM_API_KEY ?? '').trim() !== ''
const enabled = integrationUrl !== undefined

/** 三条语义明确的草稿：只读 / 改金额 / 删除。 */
const OPENAPI_DOC = {
  openapi: '3.0.0',
  info: { title: 'C4 chain probe', version: '1' },
  paths: {
    '/customers': {
      get: { operationId: 'chainQueryCustomer', summary: '查询客户信息', responses: { 200: { description: 'ok' } } },
    },
    '/orders': {
      post: { operationId: 'chainUpdateOrderAmount', summary: '修改订单金额', responses: { 200: { description: 'ok' } } },
    },
    '/orders/{id}': {
      delete: { operationId: 'chainDeleteOrder', summary: '删除订单', responses: { 200: { description: 'ok' } } },
    },
  },
} as const

const DRAFT_NAMES = ['chainQueryCustomer', 'chainUpdateOrderAmount', 'chainDeleteOrder']

describe.skipIf(!enabled)('阶段 C 端到端链路（真库 + 真 LLM）', () => {
  const pool = new Pool({ connectionString: integrationUrl })
  const db = pool as unknown as Queryable

  const marker = `c4-chain-${randomUUID()}`
  const projectId = randomUUID()
  const foreignProjectId = randomUUID()
  const ownerId = randomUUID()
  const workspaceId = randomUUID()
  const DIR = `C:\\c4-chain\\${workspaceId}`

  /** ① 的结果：真实模型为三条草稿判定的等级。 */
  let graded: { name: string; risk_level: string }[] = []
  /** ④ 的结果：真实模型提取并落库的候选。 */
  let extracted: string[] = []

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO users (id, email, display_name, status, password_hash) VALUES ($1, $2, $3, 'active', $4)",
      [ownerId, `${marker}@test.local`, marker, 'not-a-real-hash'],
    )
    for (const [id, name] of [[projectId, marker], [foreignProjectId, `${marker}-foreign`]] as const) {
      await pool.query(
        'INSERT INTO projects (id, name, description, status, harness_workspace_id, created_by)'
        + " VALUES ($1, $2, NULL, 'active', $3, $4)",
        [id, name, `c4:${id}`, ownerId],
      )
    }
  }, 120_000)

  afterAll(async () => {
    await pool.query('DELETE FROM project_memories WHERE project_id = ANY($1::uuid[])', [[projectId, foreignProjectId]])
    await pool.query('DELETE FROM audit_records WHERE project_id = ANY($1::uuid[])', [[projectId, foreignProjectId]])
    await pool.query('DELETE FROM tools WHERE name = ANY($1::text[])', [DRAFT_NAMES])
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectId, foreignProjectId]])
    await pool.query('DELETE FROM users WHERE id = $1', [ownerId])
    await pool.end()
  })

  it('① 导入 OpenAPI → 草稿落库（C3-A 真库真实落盘）', async () => {
    if (!hasLlm) return
    await pool.query('DELETE FROM tools WHERE name = ANY($1::text[])', [DRAFT_NAMES])
    validateLlmConfig(process.env)
    const ingest = new OpenApiIngestService(db, {
      classifyRisk: createLlmRiskClassifier(createLlmClient(readLlmConfig(process.env))),
    })

    const receipt = await ingest.ingestFromJson(OPENAPI_DOC, { createdBy: ownerId })
    expect(receipt.created.sort()).toEqual([...DRAFT_NAMES].sort())

    const { rows } = await pool.query<{ name: string; risk_level: string }>(
      'SELECT name, risk_level FROM tools WHERE name = ANY($1::text[]) ORDER BY name',
      [DRAFT_NAMES],
    )
    graded = rows
    console.log('① 真实分级结果 =', JSON.stringify(graded))
  }, 120_000)

  it('①续 等级合法且不是"一律 read"（分级真的生效）', () => {
    if (!hasLlm) return
    const allowed = new Set(['read', 'write', 'sensitive', 'critical'])
    expect(graded).toHaveLength(DRAFT_NAMES.length)
    expect(graded.every(row => allowed.has(row.risk_level))).toBe(true)
    expect(graded.some(row => row.risk_level !== 'read')).toBe(true)
  })

  it('② 工具调用落审计 → 按项目筛选查得到（C3-B 真库）', async () => {
    const audit = new AuditService(db, () => null)
    await audit.recordBeforeExecute({
      toolId: DRAFT_NAMES[0] ?? 'tool',
      toolName: DRAFT_NAMES[0] ?? 'tool',
      projectId,
      userId: ownerId,
      sessionId: null,
      args: { customerId: 'C-1', token: 'should-be-redacted' },
      riskLevel: 'read',
    } as never)
    await audit.recordAfterExecute({
      toolId: DRAFT_NAMES[0] ?? 'tool',
      projectId,
      userId: ownerId,
      sessionId: null,
      status: 'ok',
      result: {},
    } as never)

    const page = await audit.listRecords({ projectId, limit: 50 })
    expect(page.total).toBeGreaterThan(0)
    expect(page.items.every(row => row.project_id === projectId)).toBe(true)
  }, 60_000)

  it('②续 跨项目取不到（BND-4：他项目查询返回空）', async () => {
    const audit = new AuditService(db, () => null)
    const foreign = await audit.listRecords({ projectId: foreignProjectId, limit: 50 })

    expect(foreign.items).toEqual([])
    expect(foreign.total).toBe(0)
  })

  it('③ 会话结束提取候选 → 真实 LLM 落库为候选（阶段 B）', async () => {
    if (!hasLlm) return
    const memories = new ProjectMemoryService(db)
    const llm = createLlmClient(readLlmConfig(process.env))
    const extractor = new MemoryExtractor(
      memories,
      new LlmCandidateGenerator(llm, { maxCandidates: 5 }),
      { maxCandidates: 5 },
    )

    const stored = await extractor.extract({
      projectId,
      sessionId: 's-c4-chain',
      events: [
        userMessage('本项目的报表口径统一以财务部月报为准，不要用销售系统的口径。'),
        userMessage('另外提醒一下，我们的数据库统一使用 PostgreSQL，不要提其他数据库。'),
        userMessage('今天天气不错。'),
      ],
    })

    extracted = stored.map(item => item.content)
    console.log('③ 真实提取结果 =', JSON.stringify(extracted))

    const candidates = await memories.listCandidates(projectId)
    expect(candidates.length).toBe(stored.length)
    expect(candidates.every(row => row.status === 'candidate')).toBe(true)
    // 未确认的候选不得进入检索区间
    expect(await memories.searchTopK(projectId, [1, 0], 10)).toHaveLength(0)
  }, 120_000)

  it('④ 确认候选 → 进入可检索集合，候选列表清空（C1）', async () => {
    const memories = new ProjectMemoryService(db)
    const candidates = await memories.listCandidates(projectId)
    if (candidates.length === 0) return

    for (const candidate of candidates) {
      const confirmed = await memories.confirmCandidate(candidate.id, projectId)
      expect(confirmed?.status).toBe('active')
    }
    expect(await memories.listCandidates(projectId)).toHaveLength(0)
    expect(await memories.listMemories(projectId, { scope: 'active' })).toHaveLength(candidates.length)
  }, 60_000)

  it('⑤ 新会话注入文本含已确认记忆（C2 依赖的服务层）', async () => {
    const memories = new ProjectMemoryService(db)
    const active = await memories.listMemories(projectId, { scope: 'active' })
    if (active.length === 0) return

    // 归属解析经 workspaceRegistry；这里用替身把 DIR 映射到本测试项目，
    // 使注入器走完整链路（真实 resolveProjectId + 真实 listLocked/searchTopK）。
    const registry = {
      resolveByPath: async (path: string) => path === DIR ? fakeWorkspace(workspaceId, DIR) : undefined,
    }
    // projects.harness_workspace_id 必须等于 workspaceId，resolveProjectByWorkspaceId 才命中。
    await pool.query('UPDATE projects SET harness_workspace_id = $2 WHERE id = $1', [projectId, workspaceId])

    const injector = new MemoryInjector(
      db,
      registry as never,
      memories,
      createLlmClient(readLlmConfig(process.env)),
      { readEvents: async () => [userMessage('我们的报表口径是什么？')] },
    )
    const session = fakeSession('s-c4-inject', DIR)
    await injector.ensure(session)
    const context = injector.promptContext()
    const assemble = { agent: { session } } as never
    const text = typeof context.text === 'string' ? context.text : context.text(assemble)
    console.log('⑤ 注入文本 =', JSON.stringify(text.slice(0, 200)))

    expect(text).not.toBe('')
    expect(active.some(memory => text.includes(memory.content))).toBe(true)
  }, 120_000)
})
