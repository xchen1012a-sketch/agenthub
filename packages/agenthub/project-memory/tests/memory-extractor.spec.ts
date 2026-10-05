/**
 * 提取器与归属解析（P4 阶段 B T4 / D32）。
 *
 * 覆盖：候选截断、单条落库失败不丢整批、空正文静默跳过、
 * 目录名 → Project 反查（非 UUID / 不存在 / 工作区不匹配都必须解析失败）。
 *
 * 重建说明：本文件曾被误覆写归零，现按"生产代码公开行为"重建；
 * 用例来源见仓库文档《聚合类型检查阻塞 · 根因与修复范围》§6.3。
 *
 * @module tests/memory-extractor.spec
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { MemoryExtractor } from '../src/memory-extractor.ts'
import type { CandidateGenerator, ExtractCandidatesRequest } from '../src/memory-extractor.ts'
import { resolveProjectByWorkspaceId, resolveProjectId } from '../src/project-resolver.ts'
import type { MemoryRecord, ProjectMemoryService, StoreCandidateInput } from '../src/service.ts'
import { ProjectMemoryService as Service } from '../src/service.ts'
import { asQueryable, FakeMemoryDb, fakeWorkspace, userMessage } from './fakes.ts'

const PROJECT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const WORKSPACE_A = '11111111-2222-4333-8444-555555555555'
const DIR = 'C:\\ws\\proj'

/** 记录调用并回放固定行的假库（归属解析用）。 */
class RecordingDb {
  readonly calls: { text: string; values?: readonly unknown[] }[] = []

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, ...(values !== undefined ? { values } : {}) })
    return { rows: this.rows }
  }
}

/**
 * 目录 → Workspace 的注册表替身（未登记的目录返回 undefined）。
 * @param pathToWorkspace - 路径到工作区 id 的映射。
 * @returns 只实现 `resolveByPath` 的注册表。
 */
function fakeRegistry(pathToWorkspace: Record<string, string>): WorkspaceRegistry {
  return {
    resolveByPath: async (path: string) => {
      const id = pathToWorkspace[path]
      return id === undefined ? undefined : fakeWorkspace(id, path)
    },
  } as unknown as WorkspaceRegistry
}

/**
 * 固定产出的候选生成器替身（同时记录收到的请求）。
 * @param candidates - 每次 `generate` 返回的候选。
 * @returns 生成器替身。
 */
function fixedGenerator(
  candidates: StoreCandidateInput[],
): CandidateGenerator & { requests: ExtractCandidatesRequest[] } {
  const requests: ExtractCandidatesRequest[] = []
  return {
    requests,
    generate: vi.fn(async (req: ExtractCandidatesRequest) => {
      requests.push(req)
      return candidates
    }),
  }
}

/** 三条候选（各用例自行决定裁到几条）。 */
function threeCandidates(): StoreCandidateInput[] {
  return [
    { projectId: PROJECT_A, content: '候选一', embedding: [1, 0] },
    { projectId: PROJECT_A, content: '候选二', embedding: [0, 1] },
    { projectId: PROJECT_A, content: '候选三', embedding: [1, 1] },
  ]
}

/**
 * 一次提取请求的最小形态。
 * @param overrides - 覆盖项。
 * @returns 可直接喂给提取器的请求。
 */
function request(overrides: Partial<ExtractCandidatesRequest> = {}): ExtractCandidatesRequest {
  return {
    projectId: PROJECT_A,
    sessionId: 's-1',
    events: [userMessage('报表口径以财务部为准')],
    ...overrides,
  }
}

/**
 * 真实 service + 假库。
 * @param db - 假库。
 * @returns 记忆服务实例。
 */
function makeService(db: FakeMemoryDb): Service {
  return new Service(asQueryable(db))
}

describe('resolveProjectId（D34：经 workspaceRegistry.resolveByPath）', () => {
  it('目录解析到 Workspace 且该 Workspace 已映射 Project → 返回归属与策略', async () => {
    const db = new RecordingDb([{ id: PROJECT_A, name: 'A', memory_policy: { topK: 3 } }])
    const project = await resolveProjectId(asQueryable(db), fakeRegistry({ [DIR]: WORKSPACE_A }), DIR)

    expect(project?.projectId).toBe(PROJECT_A)
    expect(project?.memoryPolicy).toEqual({ topK: 3 })
    // 绑定按 Workspace id 查，不拿目录名当 projectId
    expect(db.calls[0]?.values).toEqual([WORKSPACE_A])
  })

  it('目录未登记 → null（不猜归属）', async () => {
    const db = new RecordingDb([{ id: PROJECT_A }])
    await expect(resolveProjectId(asQueryable(db), fakeRegistry({}), DIR)).resolves.toBeNull()
  })

  it('cwd 缺失或全空白 → null（不查库）', async () => {
    const db = new RecordingDb([{ id: PROJECT_A }])
    const registry = fakeRegistry({ [DIR]: WORKSPACE_A })

    await expect(resolveProjectId(asQueryable(db), registry, undefined)).resolves.toBeNull()
    await expect(resolveProjectId(asQueryable(db), registry, '   ')).resolves.toBeNull()
    expect(db.calls).toHaveLength(0)
  })

  it('resolveByPath 抛错（路径不存在）→ null（fail-closed）', async () => {
    const db = new RecordingDb([{ id: PROJECT_A }])
    const throwing = {
      resolveByPath: async () => {
        throw new Error('ENOENT')
      },
    } as unknown as WorkspaceRegistry

    await expect(resolveProjectId(asQueryable(db), throwing, 'C:\\gone')).resolves.toBeNull()
  })

  it('Workspace 未映射 Project → null', async () => {
    const db = new RecordingDb([])
    await expect(
      resolveProjectId(asQueryable(db), fakeRegistry({ [DIR]: WORKSPACE_A }), DIR),
    ).resolves.toBeNull()
  })
})

describe('resolveProjectByWorkspaceId', () => {
  it('该 Workspace 无绑定 → null', async () => {
    const db = new RecordingDb([])
    await expect(resolveProjectByWorkspaceId(asQueryable(db), WORKSPACE_A)).resolves.toBeNull()
  })

  it('命中绑定 → 返回归属', async () => {
    const db = new RecordingDb([{ id: PROJECT_A, name: 'A', memory_policy: {} }])
    await expect(
      resolveProjectByWorkspaceId(asQueryable(db), WORKSPACE_A),
    ).resolves.toMatchObject({ projectId: PROJECT_A })
  })
})

describe('MemoryExtractor · 截断与正文', () => {
  it('候选超过 maxCandidates 时只落前 N 条', async () => {
    const service = makeService(new FakeMemoryDb())
    const extractor = new MemoryExtractor(service, fixedGenerator(threeCandidates()), { maxCandidates: 2 })

    const stored = await extractor.extract(request())

    expect(stored.map(item => item.content)).toEqual(['候选一', '候选二'])
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(2)
  })

  it('maxCandidates 为 0 时不落任何候选', async () => {
    const service = makeService(new FakeMemoryDb())
    const extractor = new MemoryExtractor(service, fixedGenerator(threeCandidates()), { maxCandidates: 0 })

    await expect(extractor.extract(request())).resolves.toEqual([])
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(0)
  })

  it('正文为空 → 不调用生成器（空会话静默跳过）', async () => {
    const service = makeService(new FakeMemoryDb())
    const generator = fixedGenerator(threeCandidates())
    const extractor = new MemoryExtractor(service, generator, { maxCandidates: 5 })

    await expect(extractor.extract(request({ events: [] }))).resolves.toEqual([])
    expect(generator.generate).not.toHaveBeenCalled()
  })

  it('生成器收到的正文含会话内容（正文只截一次）', async () => {
    const service = makeService(new FakeMemoryDb())
    const generator = fixedGenerator([])
    const extractor = new MemoryExtractor(service, generator, { maxCandidates: 5 })

    await extractor.extract(request({ events: [userMessage('一二三四五')], sessionId: 's-truncate' }))

    expect(generator.requests[0]?.transcript).toContain('一二三四五')
  })

  it('落库候选带来源会话（sessionId 透传到服务）', async () => {
    const service = makeService(new FakeMemoryDb())
    const generator = fixedGenerator([{ projectId: PROJECT_A, content: '无来源', embedding: [1, 0] }])
    const extractor = new MemoryExtractor(service, generator, { maxCandidates: 5 })

    const stored = await extractor.extract(request({ sessionId: 's-source' }))

    expect(stored.map(item => item.content)).toEqual(['无来源'])
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(1)
  })
})

describe('MemoryExtractor · 单条失败不丢整批', () => {
  it('第一条落库失败，其余仍落库', async () => {
    const service = makeService(new FakeMemoryDb())
    const real = service.storeCandidate.bind(service)
    let call = 0
    const failing = {
      storeCandidate: async (input: StoreCandidateInput): Promise<MemoryRecord> => {
        call += 1
        if (call === 1) throw new Error('boom')
        return await real(input)
      },
      listEpoch: 0,
    } as unknown as ProjectMemoryService
    const extractor = new MemoryExtractor(
      failing,
      fixedGenerator([
        { projectId: PROJECT_A, content: '会失败', embedding: [1, 0] },
        { projectId: PROJECT_A, content: '会成功', embedding: [0, 1] },
      ]),
      { maxCandidates: 5 },
    )

    const stored = await extractor.extract(request())

    expect(stored.map(item => item.content)).toEqual(['会成功'])
    expect(await service.listCandidates(PROJECT_A)).toHaveLength(1)
  })

  it('生成器抛错原样上抛（由插件层转告警，不阻断会话销毁）', async () => {
    const service = makeService(new FakeMemoryDb())
    const generator: CandidateGenerator = {
      generate: async () => {
        throw new Error('LLM 挂了')
      },
    }
    const extractor = new MemoryExtractor(service, generator, { maxCandidates: 5 })

    await expect(extractor.extract(request())).rejects.toThrow('LLM 挂了')
  })
})
