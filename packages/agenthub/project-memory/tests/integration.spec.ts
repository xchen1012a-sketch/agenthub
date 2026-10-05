/**
 * 项目记忆集成测试（P4 阶段 B 阶段验收）。
 *
 * 沿用 P2/P3 惯例：经 `AGENTHUB_TEST_DATABASE_URL` 连真实 PostgreSQL（compose 的
 * pgvector 镜像）；未设置时整组跳过。覆盖内存假库证明不了的部分：
 * `::vector` 字面量写入、`<=>` 真实排序、`::uuid` 转换失败路径、跨 Project 写入拒绝。
 *
 * 验证项：
 * - V4：ProjectA 的检索结果 ⊆ ProjectA；ProjectB 检索结果为空；
 * - V5：含 token 的正文落库即被打码；
 * - D33：用 ProjectB 的 projectId 改写 / 删除 ProjectA 的行一律失败且行不变。
 *
 * @module tests/integration.spec
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Queryable } from '@agenthub/_shared'
import { ProjectMemoryService } from '../src/index.ts'

const DB_URL = process.env.AGENTHUB_TEST_DATABASE_URL
const suite = DB_URL === undefined ? describe.skip : describe

/**
 * 真实维度向量（迁移 0015 后列固定 `VECTOR(2048)`；D35 实测 doubao-embedding-vision 输出 2048 维）。
 * `V_A` 与 `V_FAR` 正交，余弦距离 0 与 1；`V_NEAR` 略偏向 `V_A` 用来验排序而不是并列。
 */
function unitVector(mainIndex: number, leakIndex?: number): number[] {
  const vector = new Array<number>(2048).fill(0)
  vector[mainIndex] = 1
  if (leakIndex !== undefined) vector[leakIndex] = 0.05
  return vector
}

const V_A = unitVector(0)
const V_FAR = unitVector(1)
const V_NEAR = unitVector(0, 1)

suite('project_memories 集成（真 pgvector）', () => {
  let pool: Pool
  let db: Queryable
  let service: ProjectMemoryService
  let projectA: string
  let projectB: string
  let user: string

  /** 取某 Project 的 harness_workspace_id（D34 的绑定键）。 */
  async function workspaceIdOf(projectId: string): Promise<string> {
    const { rows } = await pool.query<{ harness_workspace_id: string }>(
      'SELECT harness_workspace_id FROM projects WHERE id = $1',
      [projectId],
    )
    return rows[0]!.harness_workspace_id
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL })
    db = pool
    service = new ProjectMemoryService(db)

    // 上一轮失败可能留下残留（beforeAll 失败时 afterAll 不会执行），先清干净再造数据，
    // 否则「A 的记忆」这类断言会被历史行污染（曾实测踩到）。
    await pool.query("DELETE FROM projects WHERE harness_workspace_id LIKE 'mem-it%'")
    await pool.query("DELETE FROM users WHERE email LIKE 'memory-it-%@example.test'")

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const { rows: userRows } = await pool.query<{ id: string }>(
      "INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'memory-it', 'x') RETURNING id",
      [`memory-it-${suffix}@example.test`],
    )
    user = userRows[0]!.id
    const created = await pool.query<{ id: string }>(
      'INSERT INTO projects (name, harness_workspace_id, created_by) VALUES ($1, $2, $3) RETURNING id',
      ['memory-it', `mem-it:${suffix}`, user],
    )
    projectA = created.rows[0]!.id
    const createdB = await pool.query<{ id: string }>(
      'INSERT INTO projects (name, harness_workspace_id, created_by) VALUES ($1, $2, $3) RETURNING id',
      ['memory-it-b', `mem-it-b:${suffix}`, user],
    )
    projectB = createdB.rows[0]!.id
  })

  afterAll(async () => {
    if (pool === undefined) return
    // Project 删除级联清掉记忆行；用户最后删（projects.created_by 无级联）。
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectA, projectB]])
    await pool.query('DELETE FROM users WHERE id = $1', [user])
    await pool.end()
  })

  it('V4：检索与列表严格限定在归属 Project 内', async () => {
    const a = await service.storeCandidate({ projectId: projectA, content: 'A 的记忆', embedding: V_A })
    const b = await service.storeCandidate({ projectId: projectB, content: 'B 的记忆', embedding: V_A })
    await service.confirmCandidate(a.id, projectA)
    await service.confirmCandidate(b.id, projectB)

    const resultA = await service.searchTopK(projectA, V_A, 10)
    expect(resultA.map(item => item.content)).toEqual(['A 的记忆'])
    expect(resultA.every(item => item.projectId === projectA)).toBe(true)

    const resultB = await service.searchTopK(projectB, V_A, 10)
    expect(resultB.map(item => item.content)).toEqual(['B 的记忆'])
    expect(resultB.some(item => item.projectId === projectA)).toBe(false)

    // 不存在的 Project 检索恒为空（不因缺过滤而全表返回）
    const empty = await service.searchTopK('00000000-0000-4000-8000-000000000000', V_A, 10)
    expect(empty).toEqual([])
  })

  it('V4：候选与软删行都不进检索区间，锁定项单独全量取', async () => {
    const candidate = await service.storeCandidate({ projectId: projectA, content: '未确认候选', embedding: V_A })
    expect((await service.searchTopK(projectA, V_A, 10)).some(item => item.id === candidate.id)).toBe(false)

    const locked = await service.storeCandidate({ projectId: projectA, content: '锁定事实', embedding: V_FAR })
    await service.confirmCandidate(locked.id, projectA)
    await service.setLocked(locked.id, true, projectA)
    const topK = await service.searchTopK(projectA, V_A, 10)
    expect(topK.some(item => item.id === locked.id)).toBe(false)
    expect((await service.listLocked(projectA)).map(item => item.id)).toContain(locked.id)

    const soft = await service.storeCandidate({ projectId: projectA, content: '软删', embedding: V_A })
    await service.confirmCandidate(soft.id, projectA)
    await service.softDelete(soft.id, projectA)
    expect((await service.searchTopK(projectA, V_A, 10)).some(item => item.id === soft.id)).toBe(false)
  })

  it('V4：余弦距离真实生效（近向量排在远向量之前）', async () => {
    const near = await service.storeCandidate({ projectId: projectA, content: 'near', embedding: V_NEAR })
    const far = await service.storeCandidate({ projectId: projectA, content: 'far', embedding: V_FAR })
    await service.confirmCandidate(near.id, projectA)
    await service.confirmCandidate(far.id, projectA)

    const result = await service.searchTopK(projectA, V_A, 10)
    const nearIndex = result.findIndex(item => item.id === near.id)
    const farIndex = result.findIndex(item => item.id === far.id)
    expect(nearIndex).toBeGreaterThanOrEqual(0)
    expect(farIndex).toBeGreaterThan(nearIndex)
  })
  it('V5：含 token / password 的正文落库即被打码（DB 行也不含明文）', async () => {
    const rec = await service.storeCandidate({
      projectId: projectA,
      content: 'conn token=super-secret-123 password: hunter2',
      embedding: V_A,
    })
    expect(rec.content).not.toContain('super-secret-123')
    expect(rec.content).not.toContain('hunter2')

    const { rows } = await pool.query<{ content: string }>(
      'SELECT content FROM project_memories WHERE id = $1',
      [rec.id],
    )
    expect(rows[0]?.content).not.toContain('super-secret-123')
    expect(rows[0]?.content).not.toContain('hunter2')
  })

  it('D33：跨 Project 的确认 / 锁定 / 软删 / 硬删 / 拒删一律失败且行不变', async () => {
    const rec = await service.storeCandidate({ projectId: projectA, content: 'D33 目标行', embedding: V_A })

    await expect(service.confirmCandidate(rec.id, projectB)).resolves.toBeNull()
    await expect(service.setLocked(rec.id, true, projectB)).resolves.toBeNull()
    await expect(service.softDelete(rec.id, projectB)).resolves.toBe(false)
    await expect(service.hardDelete(rec.id, projectB)).resolves.toBe(false)
    await expect(service.rejectCandidate(rec.id, projectB)).resolves.toBe(false)

    const { rows } = await pool.query<{ metadata: Record<string, unknown>; locked: boolean }>(
      'SELECT metadata, locked FROM project_memories WHERE id = $1 AND project_id = $2',
      [rec.id, projectA],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata.status).toBe('candidate')
    expect(rows[0]?.locked).toBe(false)

    // 归属正确时同一行可以正常确认 / 删除
    expect(await service.confirmCandidate(rec.id, projectA)).not.toBeNull()
    expect(await service.hardDelete(rec.id, projectA)).toBe(true)
  })

  it('D34：真实 Workspace 反查到归属（按 harness_workspace_id，不拿目录名当 projectId）', async () => {
    const { resolveProjectByWorkspaceId } = await import('../src/project-resolver.ts')
    const workspaceA = await workspaceIdOf(projectA)
    const resolved = await resolveProjectByWorkspaceId(db, workspaceA)
    expect(resolved?.projectId).toBe(projectA)

    // 目录名（= projectId）不是 Workspace id：绝不能命中
    await expect(resolveProjectByWorkspaceId(db, projectA)).resolves.toBeNull()
    await expect(resolveProjectByWorkspaceId(db, 'not-a-workspace-id')).resolves.toBeNull()
  })

  it('listMemories：scope 与 includeDeleted 真实生效', async () => {
    const active = await service.storeCandidate({ projectId: projectB, content: '已确认', embedding: V_A })
    await service.confirmCandidate(active.id, projectB)
    const candidate = await service.storeCandidate({ projectId: projectB, content: '候选', embedding: V_A })
    const deleted = await service.storeCandidate({ projectId: projectB, content: '已软删', embedding: V_A })
    await service.confirmCandidate(deleted.id, projectB)
    await service.softDelete(deleted.id, projectB)

    const ids = async (options?: Parameters<typeof service.listMemories>[1]): Promise<string[]> =>
      (await service.listMemories(projectB, options)).map(item => item.id)

    expect(await ids()).toEqual(expect.arrayContaining([active.id, candidate.id]))
    expect(await ids()).not.toContain(deleted.id)
    expect(await ids({ scope: 'active' })).not.toContain(candidate.id)
    expect(await ids({ includeDeleted: true })).toContain(deleted.id)
  })
})
