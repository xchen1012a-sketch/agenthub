/**
 * 测试假实现（project-memory 单测专用）：语义化内存表，忠实复刻
 * `project_memories` 的过滤 / 排序 / 删除语义与写入归属判定（D33），
 * 不触真实 PostgreSQL。
 * 排序用 cosine 相似度等价 `<=>`（cos 距离升序 = 相似度降序）。
 *
 * `query` 声明为泛型方法以贴合 `Queryable` 签名；行面经 `asRows` 集中断言——
 * `Queryable` 的行类型带 `any` 值（`QueryResult<R>`），假 DB 只能造
 * `Record<string, unknown>`，二者无法静默互认，故断言收敛在本文件一处。
 *
 * @module tests/fakes
 */
import { vi } from 'vitest'
import type { QueryResultRow } from 'pg'
import type { LlmClient, Queryable } from '@agenthub/_shared'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'

/**
 * 上游对象的最小合法替身，**集中定义、供本包所有测试复用**。
 *
 * 为什么集中：这些形状由上游包决定（`Workspace` / `SessionHeader` / `SessionEvent`）。
 * 形状散落在各测试文件里时，上游一改就要多处同改，且漏改只在聚合类型检查里才暴露。
 * 集中后上游变更只需改本文件，编译器会精确指出缺了哪个字段。
 *
 * 关键陷阱：`AssembleContext.agent` 由 `@deepseek-ai/dsh-agent` 的 declare module 增强提供，
 * 而**增强只在 import 了它的文件里可见**。测试文件必须自己 `import type {}` 该包，
 * 否则同一份代码会随构建顺序在"能过/不能过"之间漂移。
 */

/** 上游 `SessionId` 品牌类型：测试常量需要显式断言，品牌无法由字面量推导。 */
export function sessionId(value: string): SessionId {
  return value as SessionId
}

/** 上游 `WorkspaceId` 品牌类型。 */
export function workspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

/**
 * 最小合法 `SessionHeader`（上游必需字段：version / id / createdAt / isSeeded）。
 * @param id - 会话 id。
 * @param cwd - 会话工作目录（记忆归属解析依赖它）。
 * @returns 可直接用于 `Session.header` 的头部。
 */
export function fakeSessionHeader(id: string, cwd: string): SessionHeader {
  return { version: 4, id: sessionId(id), createdAt: 1_760_000_000_000, cwd, isSeeded: false }
}

/**
 * 最小合法 `Session`。
 * @param id - 会话 id。
 * @param cwd - 会话工作目录。
 * @returns 只带 `id` 与合法 `header` 的会话替身。
 */
export function fakeSession(id: string, cwd: string): Session {
  return { id: sessionId(id), header: fakeSessionHeader(id, cwd) } as unknown as Session
}

/**
 * 最小合法 `Workspace`。
 *
 * `Workspace` 是带方法的类（`setTitle` / `attachSession` / `detachSession` / `status` …），
 * 而生产代码只读 `resolveByPath` 的结果并取 `.id`。断言面**收敛在本文件这一处**，
 * 而不是散到每个调用点——上游若让这些方法成为必需，编译器只会在这里报一次。
 * @param id - 工作区 id（原始字符串，内部转品牌类型）。
 * @param path - 工作区规范路径。
 * @param title - 展示标题；缺省取路径末段。
 * @returns 注册表 `resolveByPath` 可直接返回的工作区替身。
 */
export function fakeWorkspace(id: string, path: string, title?: string): Workspace {
  return {
    id: workspaceId(id),
    path,
    title: title ?? (path.split(/[\\/]/).pop() ?? path),
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    sessionIds: [],
  } as unknown as Workspace
}

/**
 * 最小合法 `user/message` 事件（注入器从正文里取检索向量）。
 * @param text - 消息正文。
 * @returns 模型可见正文事件。
 */
export function userMessage(text: string): SessionEvent {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } } as unknown as SessionEvent
}

/**
 * 最小合法 `step/start` 事件（必需 payload：`{ turn, step }`）。
 * @param turn - 回合号。
 * @param step - 步号。
 * @returns 非正文事件（用于断言"只有正文才进检索"）。
 */
export function stepStart(turn = 1, step = 1): SessionEvent {
  return { type: 'step/start', data: { turn, step } } as unknown as SessionEvent
}

/** 记录调用的 LLM 替身：断言面是显式 mock 方法，避免 `as unknown as` 与 unbound-method。 */
export interface FakeLlm extends LlmClient {
  readonly embedTexts: ReturnType<typeof vi.fn<(texts: string[]) => Promise<number[][]>>>
  readonly completeJson: ReturnType<typeof vi.fn<(system: string, user: string) => Promise<unknown>>>
}

/**
 * 造一个 LLM 替身：向量化按序回放，补全返回空对象。
 * @param vectors - 依次回放的向量。
 * @returns 可直接断言调用次数的替身。
 */
export function createFakeLlm(vectors: number[][] = [[0.5, 0.5]]): FakeLlm {
  return {
    embedTexts: vi.fn(async (texts: string[]) => texts.map((_, index) => vectors[index] ?? [0.5, 0.5])),
    completeJson: vi.fn(async () => ({})),
  }
}

interface FakeMemoryRow {
  id: string
  project_id: string
  content: string
  embedding: number[] | null
  metadata: Record<string, unknown>
  locked: boolean
  created_at: string
  updated_at: string
}

function parseVector(s: string): number[] {
  const inner = s.slice(1, -1)
  if (inner === '') return []
  return inner.split(',').map(part => Number(part))
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** 复刻服务 SELECT 的列面（不含 embedding）。 */
function rowView(row: FakeMemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    content: row.content,
    locked: row.locked,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** `id`-only 结果面（UPDATE / DELETE ... RETURNING id）。 */
function idView(row: FakeMemoryRow): Record<string, unknown> {
  return { id: row.id }
}

/**
 * 把假 DB 的行面折成 QueryResultRow[]（Queryable 的行面类型）。
 *
 * 假 DB 只造 Record<string, unknown>，与带 ny 值的 QueryResultRow 不能静默互认，
 * 故断言收敛在本文件这一处。
 * @param rows - 假 DB 实际构造的行。
 * @returns 同一批行，按 Queryable 的行面呈现。
 */
function asRows(rows: Record<string, unknown>[]): QueryResultRow[] {
  return rows
}

/** 具备假 `query` 的最小面（`FakeMemoryDb` 与各记录库都满足）。 */
interface FakeQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * 把假 DB 交给需要 `Queryable` 的调用点。
 *
 * 假 DB 只能造 `Record<string, unknown>` 行，无法满足 `Queryable` 的泛型 `query<R>`；
 * 与伪造 `WorkspaceRegistry` / `Agent` 同理——**断言收敛在本文件一处**，
 * 而不是散到每个测试文件的每个调用点。
 * @param fake - 假 DB 实例。
 * @returns 同一实例，按 `Queryable` 呈现。
 */
export function asQueryable(fake: FakeQueryable): Queryable {
  return fake as unknown as Queryable
}

/** 检索区间：非候选、非软删。 */
function active(row: FakeMemoryRow): boolean {
  return row.metadata.status !== 'candidate' && row.metadata.deleted !== true
}

/** D33 归属判定：只有 id 与 project_id 同时命中才算改到这一行。 */
function owned(row: FakeMemoryRow | undefined, id: unknown, projectId: unknown): row is FakeMemoryRow {
  return row !== undefined && row.id === id && row.project_id === projectId
}

/**
 * 语义化假 DB：按真实 SQL 文本分支，识别 `project_id` 过滤子句
 * （`WHERE project_id = $1` 检索面；`AND project_id = $2` 写入面）。
 * `statements` 记录每条 SQL 与参数，供「隔离契约」断言直接检查 SQL 文本。
 *
 * `query` 声明为泛型方法，与 `Queryable` 的签名一致——这样假实现直接满足接口，
 * 调用点不需要 `as unknown as Queryable`（该断言被 `verify-no-unknown-casts` 禁止）。
 */
export class FakeMemoryDb {
  readonly statements: { text: string; values?: readonly unknown[] }[] = []
  private readonly rows = new Map<string, FakeMemoryRow>()
  private nextId = 1
  private readonly now = '2026-10-02T00:00:00.000Z'

  /**
   * 假查询：按 SQL 形状回放。
   *
   * 返回 `QueryResultRow[]` 而非泛型 `R[]`——假 DB 无法声明"我就是调用方要的行类型"。
   * 把它交给需要 `Queryable` 的调用点时用 {@link asQueryable} 统一断言。
   * @param text - SQL 文本（按前缀 / 子串分支）。
   * @param values - 绑定参数。
   * @returns 该语句形状对应的行集。
   */
  async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: QueryResultRow[] }> {
    this.statements.push({ text, ...(values !== undefined ? { values } : {}) })
    const v = values ?? []

    if (text.startsWith('INSERT INTO project_memories')) {
      const row: FakeMemoryRow = {
        id: `mem-${this.nextId}`,
        project_id: v[0] as string,
        content: v[1] as string,
        embedding: parseVector(v[2] as string),
        metadata: JSON.parse(v[3] as string) as Record<string, unknown>,
        locked: false,
        created_at: this.now,
        updated_at: this.now,
      }
      this.nextId += 1
      this.rows.set(row.id, row)
      return { rows: asRows([rowView(row)]) }
    }
    if (text.startsWith('UPDATE') && text.includes("metadata->>'status' = 'candidate'")) {
      const row = this.rows.get(v[0] as string)
      if (!owned(row, v[0], v[1]) || row.metadata.status !== 'candidate') return { rows: [] }
      row.metadata = { ...row.metadata, status: 'active' }
      return { rows: asRows([rowView(row)]) }
    }
    if (text.startsWith('UPDATE') && text.includes('SET locked =')) {
      const row = this.rows.get(v[0] as string)
      if (!owned(row, v[0], v[2])) return { rows: [] }
      row.locked = v[1] as boolean
      return { rows: asRows([rowView(row)]) }
    }
    if (text.startsWith('UPDATE') && text.includes('"deleted":true')) {
      const row = this.rows.get(v[0] as string)
      if (!owned(row, v[0], v[1])) return { rows: [] }
      row.metadata = { ...row.metadata, deleted: true }
      return { rows: asRows([idView(row)]) }
    }
    if (text.startsWith('DELETE') && text.includes("'candidate'")) {
      const row = this.rows.get(v[0] as string)
      if (!owned(row, v[0], v[1]) || row.metadata.status !== 'candidate') return { rows: [] }
      this.rows.delete(row.id)
      return { rows: asRows([idView(row)]) }
    }
    if (text.startsWith('DELETE FROM project_memories WHERE id')) {
      const row = this.rows.get(v[0] as string)
      if (!owned(row, v[0], v[1])) return { rows: [] }
      this.rows.delete(row.id)
      return { rows: asRows([idView(row)]) }
    }
    if (text.includes('ORDER BY embedding <=>')) {
      const projectId = v[0] as string
      const query = parseVector(v[1] as string)
      const k = v[2] as number
      const items = [...this.rows.values()]
        .filter(row => row.project_id === projectId && !row.locked && active(row) && row.embedding !== null)
        .map(row => ({ row, sim: cosine(query, row.embedding as number[]) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k)
        .map(item => rowView(item.row))
      return { rows: asRows(items) }
    }
    if (text.includes('AND locked = true')) {
      const projectId = v[0] as string
      const items = [...this.rows.values()]
        .filter(row => row.project_id === projectId && row.locked && active(row))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(rowView)
      return { rows: asRows(items) }
    }
    if (text.includes('ORDER BY updated_at DESC')) {
      const projectId = v[0] as string
      const includeDeleted = !text.includes("(metadata->>'deleted') IS DISTINCT FROM 'true'")
      const candidatesOnly = text.includes("(metadata->>'status') = 'candidate'")
      const activeOnly = text.includes("(metadata->>'status') IS DISTINCT FROM 'candidate'")
      const items = [...this.rows.values()]
        .filter(row => row.project_id === projectId)
        .filter(row => includeDeleted || row.metadata.deleted !== true)
        .filter(row => !candidatesOnly || row.metadata.status === 'candidate')
        .filter(row => !activeOnly || row.metadata.status !== 'candidate')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(rowView)
      return { rows: asRows(items) }
    }
    return { rows: [] }
  }
}
