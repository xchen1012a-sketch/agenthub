/**
 * 注入器（P4 阶段 B T5）。
 *
 * 覆盖：锁定项 + Top-K 合并与去重、归属解析失败即不注入（fail-closed）、
 * 缓存命中不重复查库/向量化、turn 结束与记忆变化后的失效重算、段落形态。
 *
 * 重建说明：本文件曾被误覆写归零，现按"生产代码公开行为"重建；
 * 用例来源见仓库文档《聚合类型检查阻塞 · 根因与修复范围》§6.3。
 *
 * @module tests/injector.spec
 */
import { describe, expect, it, vi } from 'vitest'
import type { LlmClient } from '@agenthub/_shared'
import type { Session } from '@deepseek-ai/dsh-session'
// 类型面依赖：`AssembleContext.agent` 由 @deepseek-ai/dsh-agent 的 declare module 增强提供。
// 增强只在 import 了它的文件里可见，因此测试文件必须自行 import——
// 否则 `assemble.agent` 报"不存在"，且是否可见会随构建顺序变化。
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  MemoryInjector,
  mergeMemories,
  renderMemoryContext,
} from '../src/memory-injector.ts'
import type { MemoryRecord } from '../src/service.ts'
import { ProjectMemoryService } from '../src/service.ts'
import { asQueryable, createFakeLlm, FakeMemoryDb, fakeSession, fakeWorkspace, stepStart, userMessage } from './fakes.ts'

const PROJECT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const PROJECT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const WORKSPACE_A = '11111111-2222-4333-8444-555555555555'
const DIR_A = 'C:\\ws\\proj-a'

/** 记忆假库 + projects 归属查询（模拟同一连接池）。 */
class FakeUnifiedDb {
  private readonly memories = new FakeMemoryDb()

  constructor(private readonly workspaceToProject: ReadonlyMap<string, string>) {}

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (!text.includes('FROM projects')) return this.memories.query(text, values)
    const workspaceId = values?.[0] as string
    const projectId = this.workspaceToProject.get(workspaceId)
    if (projectId === undefined) return { rows: [] }
    return { rows: [{ id: projectId, name: '项目 A', memory_policy: {} }] }
  }
}

/**
 * 目录 → Workspace 的注册表替身（未登记的目录返回 undefined）。
 *
 * `WorkspaceRegistry` 是带 45+ 成员的类，本测试只关心"路径 → 工作区"这一步，
 * 故整体断言（最小合法形状对它不成立）。
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

/** 组装一套接线好的注入器（会话归属 PROJECT_A）。 */
function wired() {
  const db = new FakeUnifiedDb(new Map([[WORKSPACE_A, PROJECT_A]]))
  const memories = new ProjectMemoryService(asQueryable(db))
  const llm = createFakeLlm([[1, 0, 0]])
  const injector = new MemoryInjector(
    asQueryable(db),
    fakeRegistry({ [DIR_A]: WORKSPACE_A }),
    memories,
    llm,
    { readEvents: async () => [userMessage('报表口径以财务部为准')] },
  )
  return { injector, memories, llm, db }
}

/**
 * 走 `ensure` 并返回该会话的最终注入文本。
 * @param injector - 被测注入器。
 * @param session - 会话替身。
 * @returns 注入段落文本。
 */
async function injectedText(injector: MemoryInjector, session: Session): Promise<string> {
  await injector.ensure(session)
  return providerText(injector, session)
}

/**
 * 从同步 provider 取该会话的注入文本。
 * @param injector - 被测注入器。
 * @param session - 会话替身。
 * @returns 注入段落文本（缓存未命中时为空串）。
 */
function providerText(injector: MemoryInjector, session: Session): string {
  const context = injector.promptContext()
  // `AssembleContext.agent` 由 @deepseek-ai/dsh-agent 增强提供，上游要求完整 Agent；
  // 本测试只喂 `{ session }`，故整体断言（与 fakeRegistry 同理）。
  const assemble = { agent: { session } } as unknown as AssembleContext
  return typeof context.text === 'string' ? context.text : context.text(assemble)
}

/** 落一条已确认记忆并返回其 id。 */
async function confirmed(
  memories: ProjectMemoryService,
  projectId: string,
  content: string,
  locked = false,
): Promise<string> {
  await memories.storeCandidate({ projectId, content, embedding: [1, 0, 0] })
  const listed = await memories.listCandidates(projectId)
  const id = listed[listed.length - 1]?.id ?? ''
  await memories.confirmCandidate(id, projectId)
  if (locked) await memories.setLocked(id, true, projectId)
  return id
}

const record = (id: string, locked: boolean): MemoryRecord => ({
  id,
  projectId: PROJECT_A,
  content: `内容 ${id}`,
  locked,
  status: 'active',
  deleted: false,
  createdAt: '',
  updatedAt: '',
})

describe('renderMemoryContext', () => {
  it('空列表不注入任何东西', () => {
    expect(renderMemoryContext([])).toBe('')
  })

  it('带固定表头与编号，明示不是用户输入', () => {
    const text = renderMemoryContext([record('m1', false)])
    expect(text).toContain('自动注入')
    expect(text).toContain('不是用户输入')
    expect(text).toContain('1. 内容 m1')
  })

  it('段名与 order 显式固定（避免与上游 context 段名冲突）', () => {
    expect(MEMORY_CONTEXT_NAME).toBe('agenthub:project-memory')
    expect(MEMORY_CONTEXT_ORDER).toBeGreaterThan(120)
  })
})

describe('mergeMemories', () => {
  it('锁定项在前、相似项在后', () => {
    expect(mergeMemories([record('l1', true)], [record('s1', false)]).map(item => item.id))
      .toEqual(['l1', 's1'])
  })

  it('同一 id 同时出现在两侧时只保留一次（锁定优先）', () => {
    const merged = mergeMemories([record('dup', true)], [record('dup', false)])
    expect(merged.map(item => item.id)).toEqual(['dup'])
    expect(merged[0]?.locked).toBe(true)
  })

  it('两侧都空 → 空列表', () => {
    expect(mergeMemories([], [])).toEqual([])
  })
})

describe('MemoryInjector · 归属与 fail-closed', () => {
  it('会话缺失（assemble.agent 未提供）→ 不注入', async () => {
    const { injector } = wired()
    const context = injector.promptContext()
    const assemble = {} as unknown as AssembleContext
    expect(typeof context.text === 'string' ? context.text : context.text(assemble)).toBe('')
  })

  it('目录解析不到 Workspace → 不注入（fail-closed，不猜归属）', async () => {
    const db = new FakeUnifiedDb(new Map([[WORKSPACE_A, PROJECT_A]]))
    const memories = new ProjectMemoryService(asQueryable(db))
    await confirmed(memories, PROJECT_A, '不该被注入')
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({}),
      memories,
      createFakeLlm(),
      { readEvents: async () => [userMessage('查一下')] },
    )
    expect(await injectedText(injector, fakeSession('s-unknown', DIR_A))).toBe('')
  })

  it('Workspace 已登记但未映射 Project → 不注入', async () => {
    const db = new FakeUnifiedDb(new Map())
    const memories = new ProjectMemoryService(asQueryable(db))
    await confirmed(memories, PROJECT_A, '不该被注入')
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      createFakeLlm(),
      { readEvents: async () => [userMessage('查一下')] },
    )
    expect(await injectedText(injector, fakeSession('s-nomap', DIR_A))).toBe('')
  })
})

describe('MemoryInjector · 组装与缓存', () => {
  it('锁定项始终注入（无事件读取器也注入）', async () => {
    const { memories, db } = wired()
    await confirmed(memories, PROJECT_A, '锁定的事实', true)
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      createFakeLlm(),
      {},
    )
    expect(await injectedText(injector, fakeSession('s-locked', DIR_A))).toContain('锁定的事实')
  })

  it('首次同步取值为空串，ensure 之后才有内容（上游 provider 必须同步返回）', async () => {
    const { injector, memories } = wired()
    await confirmed(memories, PROJECT_A, '首轮为空')
    const session = fakeSession('s-first', DIR_A)

    expect(providerText(injector, session)).toBe('')
    await injector.ensure(session)
    expect(providerText(injector, session)).toContain('首轮为空')
  })

  it('缓存命中不重复查库（第二次同步取值仍是同一文本）', async () => {
    const { injector, memories } = wired()
    await confirmed(memories, PROJECT_A, '缓存项')
    const session = fakeSession('s-cache', DIR_A)

    await injector.ensure(session)
    const first = providerText(injector, session)
    expect(providerText(injector, session)).toBe(first)
    expect(first).toContain('缓存项')
  })

  it('并发 ensure 共享同一次组装（不重复向量化）', async () => {
    const { injector, llm } = wired()
    const session = fakeSession('s-concurrent', DIR_A)

    await Promise.all([injector.ensure(session), injector.ensure(session), injector.ensure(session)])
    expect(llm.embedTexts.mock.calls).toHaveLength(1)
  })

  it('invalidateSession 之后该会话重算（同步取值回到空串）', async () => {
    const { injector, memories } = wired()
    await confirmed(memories, PROJECT_A, '会话级失效')
    const session = fakeSession('s-invalidate', DIR_A)

    await injector.ensure(session)
    expect(providerText(injector, session)).toContain('会话级失效')

    injector.invalidateSession(String(session.id))
    expect(providerText(injector, session)).toBe('')
  })

  it('invalidate 清空全部会话缓存', async () => {
    const { injector } = wired()
    const session = fakeSession('s-invalidate-all', DIR_A)

    await injector.ensure(session)
    injector.invalidate()
    expect(providerText(injector, session)).toBe('')
  })

  it('记忆集合变化（listEpoch 前进）使已缓存文本失效', async () => {
    const { injector, memories } = wired()
    const session = fakeSession('s-epoch', DIR_A)
    await injector.ensure(session)

    await confirmed(memories, PROJECT_A, '新增后应重算')
    expect(providerText(injector, session)).toBe('')
  })
})

describe('MemoryInjector · 降级不阻断（QA-6）', () => {
  it('向量化失败退化为只注入锁定项', async () => {
    const { memories, db } = wired()
    await confirmed(memories, PROJECT_A, '故障时仍注入', true)
    const failing: LlmClient = {
      embedTexts: vi.fn(async () => {
        throw new Error('端点失败')
      }),
      completeJson: vi.fn(async () => ({})),
    }
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      failing,
      { readEvents: async () => [userMessage('报表口径')] },
    )
    expect(await injectedText(injector, fakeSession('s-embed-fail', DIR_A))).toContain('故障时仍注入')
  })

  it('读事件抛错退化为只注入锁定项', async () => {
    const { memories, db } = wired()
    await confirmed(memories, PROJECT_A, '读事件失败仍注入', true)
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      createFakeLlm(),
      {
        readEvents: async () => {
          throw new Error('读会话失败')
        },
      },
    )
    expect(await injectedText(injector, fakeSession('s-read-fail', DIR_A))).toContain('读事件失败仍注入')
  })

  it('只有非正文事件时不取查询向量（退化为锁定项）', async () => {
    const { memories, db } = wired()
    const llm = createFakeLlm()
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      llm,
      { readEvents: async () => [stepStart(1, 1)] },
    )
    await injector.ensure(fakeSession('s-nontext', DIR_A))
    expect(llm.embedTexts).not.toHaveBeenCalled()
  })
})

describe('MemoryInjector · 安全边界', () => {
  it('外发向量化前先打码（BND-1：用户贴的 token 不得送出）', async () => {
    const { memories, db } = wired()
    const llm = createFakeLlm()
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      llm,
      { readEvents: async () => [userMessage('帮我连一下 token=super-secret-123')] },
    )
    await injector.ensure(fakeSession('s-redact', DIR_A))
    expect(llm.embedTexts.mock.calls[0]?.[0]).toEqual(['帮我连一下 token=***'])
  })

  it('跨项目隔离：归属 A 的会话检索不到 B 项目记忆（BND-4）', async () => {
    const { memories, db } = wired()
    await confirmed(memories, PROJECT_B, 'B 项目的秘密', true)
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      createFakeLlm(),
      { readEvents: async () => [userMessage('查一下')] },
    )
    expect(await injectedText(injector, fakeSession('s-isolation', DIR_A))).not.toContain('B 项目的秘密')
  })

  it('未确认的候选不进注入（候选不得当事实用）', async () => {
    const { memories, db } = wired()
    await memories.storeCandidate({ projectId: PROJECT_A, content: '尚未确认的候选', embedding: [1, 0, 0] })
    const injector = new MemoryInjector(
      asQueryable(db),
      fakeRegistry({ [DIR_A]: WORKSPACE_A }),
      memories,
      createFakeLlm(),
      { readEvents: async () => [userMessage('查一下')] },
    )
    expect(await injectedText(injector, fakeSession('s-candidate', DIR_A))).not.toContain('尚未确认的候选')
  })
})
