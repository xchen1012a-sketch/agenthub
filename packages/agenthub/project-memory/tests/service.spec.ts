/**
 * 记忆服务（P4 阶段 B T3 / D33 归属 / V5 脱敏）。
 *
 * 覆盖：候选落库即打码、确认 / 拒绝 / 锁定 / 软删 / 硬删的生命周期、
 * **每个写操作的归属校验（D33：跨 Project 命中 0 行，不得改动）**、
 * 检索与锁定项的过滤面、`listEpoch` 只在真正改到行时前进。
 *
 * 重建说明：本文件曾被误覆写归零，原内容我仅读到开头，故按生产代码公开契约重建；
 * 用例来源见仓库文档《聚合类型检查阻塞 · 根因与修复范围》§6.3。
 *
 * @module tests/service.spec
 */
import { describe, expect, it } from 'vitest'
import { ProjectMemoryService, type MemoryRecord } from '../src/service.ts'
import { asQueryable, FakeMemoryDb } from './fakes.ts'

const PROJECT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const PROJECT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

/**
 * 建一个只连假库的服务。
 * @returns 服务与假库句柄。
 */
function wired(): { service: ProjectMemoryService; db: FakeMemoryDb } {
  const db = new FakeMemoryDb()
  return { service: new ProjectMemoryService(asQueryable(db)), db }
}

/**
 * 落一条候选。
 * @param service - 记忆服务。
 * @param projectId - 归属 Project。
 * @param content - 正文。
 * @param embedding - 向量。
 * @returns 落库后的记录。
 */
async function seed(
  service: ProjectMemoryService,
  projectId: string,
  content: string,
  embedding: number[] = [1, 0],
): Promise<MemoryRecord> {
  return await service.storeCandidate({ projectId, content, embedding })
}

describe('storeCandidate · 落库即打码（V5）', () => {
  it('content 含 token/password 键值对 → 落库被替换为 ***', async () => {
    const { service } = wired()
    const record = await seed(service, PROJECT_A, 'api token=secret123 password: hunter2')

    expect(record.content).toBe('api token=*** password=***')
  })

  it('落库候选状态为 candidate（不进检索区间）', async () => {
    const { service } = wired()
    const record = await seed(service, PROJECT_A, '待确认')

    expect(record.status).toBe('candidate')
    expect(record.locked).toBe(false)
    expect(record.deleted).toBe(false)
  })

  it('未确认候选不出现在 active 列表，但出现在候选列表', async () => {
    const { service } = wired()
    await seed(service, PROJECT_A, '候选')

    expect(await service.listMemories(PROJECT_A, { scope: 'active' })).toHaveLength(0)
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(1)
  })

  it('落库本身不推进 listEpoch（只有集合变更才推进）', async () => {
    const { service } = wired()
    const before = service.listEpoch
    await seed(service, PROJECT_A, '候选')

    expect(service.listEpoch).toBe(before)
  })
})

describe('confirmCandidate · 候选转 active', () => {
  it('确认后进入 active 列表，且不再出现在候选列表', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '规则一')

    const confirmed = await service.confirmCandidate(candidate.id, PROJECT_A)

    expect(confirmed?.status).toBe('active')
    expect(await service.listMemories(PROJECT_A, { scope: 'active' })).toHaveLength(1)
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(0)
  })

  it('重复确认返回 null（已不是候选）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '规则一')
    await service.confirmCandidate(candidate.id, PROJECT_A)

    await expect(service.confirmCandidate(candidate.id, PROJECT_A)).resolves.toBeNull()
  })

  it('确认推进 listEpoch（注入缓存需重算）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '规则一')
    const before = service.listEpoch

    await service.confirmCandidate(candidate.id, PROJECT_A)

    expect(service.listEpoch).toBeGreaterThan(before)
  })

  it('跨 Project 确认返回 null，且不推进 listEpoch（D33）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, 'A 的候选')
    const before = service.listEpoch

    await expect(service.confirmCandidate(candidate.id, PROJECT_B)).resolves.toBeNull()
    expect(service.listEpoch).toBe(before)
    // A 的候选仍是候选，未被改动
    expect((await service.listCandidates(PROJECT_A))[0]?.status).toBe('candidate')
  })

  it('不存在的 id 返回 null', async () => {
    const { service } = wired()
    await expect(service.confirmCandidate('mem-nonexistent', PROJECT_A)).resolves.toBeNull()
  })
})

describe('rejectCandidate · 物理删候选', () => {
  it('拒绝后候选被物理删除（A 类：用户明确拒绝必须硬删）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '不要这条')

    await expect(service.rejectCandidate(candidate.id, PROJECT_A)).resolves.toBe(true)
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(0)
    expect(await service.listMemories(PROJECT_A, { includeDeleted: true })).toHaveLength(0)
  })

  it('跨 Project 拒绝返回 false，行仍在（D33）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, 'A 的候选')

    await expect(service.rejectCandidate(candidate.id, PROJECT_B)).resolves.toBe(false)
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(1)
  })

  it('已确认的记忆不能被"拒绝"删掉', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '已确认')
    await service.confirmCandidate(candidate.id, PROJECT_A)

    await expect(service.rejectCandidate(candidate.id, PROJECT_A)).resolves.toBe(false)
    expect(await service.listMemories(PROJECT_A, { scope: 'active' })).toHaveLength(1)
  })
})

describe('setLocked · 锁定 / 解锁', () => {
  it('锁定后出现在 listLocked，解锁后消失', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '锁定项')
    await service.confirmCandidate(candidate.id, PROJECT_A)

    await service.setLocked(candidate.id, true, PROJECT_A)
    expect(await service.listLocked(PROJECT_A)).toHaveLength(1)

    await service.setLocked(candidate.id, false, PROJECT_A)
    expect(await service.listLocked(PROJECT_A)).toHaveLength(0)
  })

  it('跨 Project 锁定返回 null，且不推进 listEpoch（D33）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, 'A 的候选')
    const before = service.listEpoch

    await expect(service.setLocked(candidate.id, true, PROJECT_B)).resolves.toBeNull()
    expect(service.listEpoch).toBe(before)
    expect(await service.listLocked(PROJECT_A)).toHaveLength(0)
  })
})

describe('softDelete / hardDelete', () => {
  it('软删后默认列表不可见，但行仍在（includeDeleted 可回溯）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '将软删')
    await service.confirmCandidate(candidate.id, PROJECT_A)

    await expect(service.softDelete(candidate.id, PROJECT_A)).resolves.toBe(true)
    expect(await service.listMemories(PROJECT_A)).toHaveLength(0)
    expect(await service.listMemories(PROJECT_A, { includeDeleted: true })).toHaveLength(1)
  })

  it('硬删后行彻底消失（连 includeDeleted 也查不到）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, '将硬删')

    await expect(service.hardDelete(candidate.id, PROJECT_A)).resolves.toBe(true)
    expect(await service.listMemories(PROJECT_A, { includeDeleted: true })).toHaveLength(0)
  })

  it('跨 Project 软删 / 硬删返回 false，行不受影响（D33）', async () => {
    const { service } = wired()
    const candidate = await seed(service, PROJECT_A, 'A 的候选')

    await expect(service.softDelete(candidate.id, PROJECT_B)).resolves.toBe(false)
    await expect(service.hardDelete(candidate.id, PROJECT_B)).resolves.toBe(false)
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(1)
  })
})

describe('检索与锁定项 · 过滤面', () => {
  it('searchTopK 排除锁定项、候选与软删行', async () => {
    const { service } = wired()
    const locked = await seed(service, PROJECT_A, '锁定项', [1, 0])
    await seed(service, PROJECT_A, '候选', [1, 0])
    const deleted = await seed(service, PROJECT_A, '软删项', [1, 0])
    const active = await seed(service, PROJECT_A, '可检索项', [1, 0])

    await service.confirmCandidate(locked.id, PROJECT_A)
    await service.setLocked(locked.id, true, PROJECT_A)
    await service.confirmCandidate(deleted.id, PROJECT_A)
    await service.softDelete(deleted.id, PROJECT_A)
    await service.confirmCandidate(active.id, PROJECT_A)

    const contents = (await service.searchTopK(PROJECT_A, [1, 0], 10)).map(item => item.content)

    expect(contents).toContain('可检索项')
    expect(contents).not.toContain('锁定项')
    expect(contents).not.toContain('候选')
    expect(contents).not.toContain('软删项')
  })

  it('searchTopK 按相似度降序返回，且受 k 限制', async () => {
    const { service } = wired()
    const near = await seed(service, PROJECT_A, '最相近', [1, 0])
    const far = await seed(service, PROJECT_A, '较远', [0, 1])
    await service.confirmCandidate(near.id, PROJECT_A)
    await service.confirmCandidate(far.id, PROJECT_A)

    const hits = await service.searchTopK(PROJECT_A, [1, 0], 1)

    expect(hits).toHaveLength(1)
    expect(hits[0]?.content).toBe('最相近')
  })

  it('检索恒带项目归属：A 的查询取不到 B 的记忆（BND-4）', async () => {
    const { service } = wired()
    const foreign = await seed(service, PROJECT_B, 'B 的秘密', [1, 0])
    await service.confirmCandidate(foreign.id, PROJECT_B)

    expect(await service.searchTopK(PROJECT_A, [1, 0], 10)).toHaveLength(0)
    expect(await service.listLocked(PROJECT_A)).toHaveLength(0)
    expect(await service.listMemories(PROJECT_A, { includeDeleted: true })).toHaveLength(0)
  })
})

describe('listMemories · 范围与软删可见性', () => {
  it('缺省范围返回候选与已激活的全部未软删行', async () => {
    const { service } = wired()
    await seed(service, PROJECT_A, '候选')
    const active = await seed(service, PROJECT_A, '已确认')
    await service.confirmCandidate(active.id, PROJECT_A)

    expect(await service.listMemories(PROJECT_A)).toHaveLength(2)
  })

  it('scope=candidate 只返回候选，scope=active 只返回已确认', async () => {
    const { service } = wired()
    await seed(service, PROJECT_A, '候选')
    const active = await seed(service, PROJECT_A, '已确认')
    await service.confirmCandidate(active.id, PROJECT_A)

    expect((await service.listMemories(PROJECT_A, { scope: 'candidate' })).map(r => r.content)).toEqual(['候选'])
    expect((await service.listMemories(PROJECT_A, { scope: 'active' })).map(r => r.content)).toEqual(['已确认'])
  })

  it('读取面不推进 listEpoch', async () => {
    const { service } = wired()
    await seed(service, PROJECT_A, '候选')
    const before = service.listEpoch

    await service.listMemories(PROJECT_A)
    await service.listCandidates(PROJECT_A)
    await service.listLocked(PROJECT_A)
    await service.searchTopK(PROJECT_A, [1, 0], 5)

    expect(service.listEpoch).toBe(before)
  })
})
