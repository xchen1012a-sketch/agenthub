/**
 * SessionPersistence 的 PostgreSQL 后端（P2 方案书 T8 / D4：表结构以
 * SessionPersistence 真实契约为准）。
 *
 * 语义映射：
 *   - `append` 逐批 INSERT + 回写主表 event_count：append 解析即持久（单条
 *     SQL 提交），`flush` 因此是 materialize-if-needed 的空操作——主表行在
 *     create 时即落库（会话立即对所有进程可见，契约允许的 eager materialize）。
 *   - 写所有权为进程内单写者（Map 登记）；跨进程并发写由上游 session 层
 *     单进程模型规避，P2 不引入租约表（与 jsonl 同代际语义）。
 *   - revision 用 event_count（事件只追加，计数变化即日志变化）。
 *
 * @module @agenthub/postgres-session-provider/service
 */
import {
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type { Context } from '@deepseek-ai/cordis'
import type { Queryable } from '@agenthub/_shared'

/** agenthub_sessions 主表行（BIGINT 经 pg 返回 string）。 */
interface SessionRow {
  readonly header: SessionHeader
  readonly inherited_event_count: string
  readonly event_count: string
}

/** 服务内复用的行元组：BIGINT 已转数字，header 已过版本/身份门。 */
interface ReadyRow {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly eventCount: number
}

/**
 * PostgreSQL 上的 {@link SessionPersistence}。表结构见迁移
 * 0009_migrations_harness_sessions.sql（agenthub_sessions + agenthub_session_events）。
 */
export class PostgresSessionPersistence extends SessionPersistence {
  /** Backend label for diagnostics; shadows `Service.name` without changing the service key. */
  override readonly name = 'agenthub-session-postgres'

  /** 进程内写所有权登记：id → 活跃 write handle。 */
  private readonly owners = new Map<SessionId, PgSessionHandle>()

  private readonly db: Queryable

  constructor(ctx: Context, db: Queryable) {
    super(ctx)
    this.db = db
  }

  // --- SessionPersistence service API ---

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    // 契约：isSeeded 必须显式给出继承前缀长度；非 seeded 必须省略或 0。
    if (snapshot.isSeeded) {
      if (options?.inheritedEventCount === undefined) {
        throw new TypeError(`seeded session "${snapshot.id}" requires an explicit inheritedEventCount`)
      }
    } else if ((options?.inheritedEventCount ?? 0) !== 0) {
      throw new TypeError(`session "${snapshot.id}" is not seeded but inheritedEventCount was provided`)
    }
    const inherited = SessionLogOffset(options?.inheritedEventCount ?? 0)
    const { rows } = await this.db.query<{ id: string }>(
      'INSERT INTO agenthub_sessions (id, version, header, inherited_event_count, event_count)'
      + ' VALUES ($1, $2, $3, $4, 0) ON CONFLICT (id) DO NOTHING RETURNING id',
      [snapshot.id, snapshot.version, snapshot, inherited],
    )
    if (rows.length === 0) throw new SessionAlreadyExistsError(snapshot.id)
    const handle = new PgSessionHandle(this.db, this.owners, snapshot.id, snapshot, 'write', 0, inherited)
    this.owners.set(snapshot.id, handle)
    return handle
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const row = await this.requireRow(id, options?.signal)
    if (access === 'write') {
      if (this.owners.has(id)) throw new SessionAlreadyOwnedError(id)
      const handle = new PgSessionHandle(this.db, this.owners, id, row.header, 'write', row.eventCount, row.inheritedEventCount)
      this.owners.set(id, handle)
      return handle
    }
    return new PgSessionHandle(this.db, this.owners, id, row.header, 'read', row.eventCount, row.inheritedEventCount)
  }

  flush(): Promise<void> {
    // append 解析即持久：所有在册 write handle 无待 drain 批次，聚合屏障为空。
    return Promise.resolve()
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const row = await this.findRow(id, options?.signal)
    if (row === undefined) return undefined
    return {
      header: row.header,
      revision: SessionPersistenceRevision(String(row.eventCount)),
      eventCount: row.eventCount,
    }
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    const { rows } = await this.db.query<SessionRow>(
      'SELECT header, inherited_event_count, event_count FROM agenthub_sessions',
    )
    return rows.map(row => ({
      header: row.header,
      revision: SessionPersistenceRevision(row.event_count),
      eventCount: Number(row.event_count),
    }))
  }

  /** 读取并校验一行主表元数据；不存在抛 SessionPersistenceNotFoundError。 */
  private async requireRow(id: SessionId, signal?: AbortSignal): Promise<ReadyRow> {
    const row = await this.findRow(id, signal)
    if (row === undefined) throw new SessionPersistenceNotFoundError(id)
    return row
  }

  /** 读取一行主表元数据（可能 undefined），过身份与版本门。 */
  private async findRow(id: SessionId, signal?: AbortSignal): Promise<ReadyRow | undefined> {
    signal?.throwIfAborted()
    const { rows } = await this.db.query<SessionRow>(
      'SELECT header, inherited_event_count, event_count FROM agenthub_sessions WHERE id = $1',
      [id],
    )
    const raw = rows[0]
    if (raw === undefined) return undefined
    const header = raw.header
    assertStoredId(id, header)
    assertVersion(header)
    return {
      header,
      inheritedEventCount: SessionLogOffset(Number(raw.inherited_event_count)),
      eventCount: Number(raw.event_count),
    }
  }
}

/**
 * One open channel onto a PostgreSQL-stored session. `append` 逐批持久；
 * `read` 直接查事件表（write handle 天然读到自己的成功 append）。
 */
export class PgSessionHandle implements SessionHandle {
  private closed = false

  constructor(
    private readonly db: Queryable,
    private readonly owners: Map<SessionId, PgSessionHandle>,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    /** 逻辑游标：已持久事件数（write handle 的下一 append 起点）。 */
    private cursor: number,
    readonly inheritedEventCount: SessionLogOffset,
  ) {}

  async read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    options?.signal?.throwIfAborted()
    this.assertOpen('read')
    const from = offset ?? 0
    const params: unknown[] = [this.id, from]
    let text = 'SELECT event FROM agenthub_session_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq'
    if (length !== undefined) {
      text += ' LIMIT $3'
      params.push(length)
    }
    const { rows } = await this.db.query<{ event: SessionEvent }>(text, params)
    // adopt 后深冻结：来自 DB 的新对象，eventState 恒为 shared-frozen。
    const events = validateStoredEvents(this.header, rows.map(row => row.event))
    return { eventState: 'shared-frozen', events }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    options?.signal?.throwIfAborted()
    this.assertOpen('append')
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    const batch = materializeAppendBatch(events)
    assertContiguous(this.id, batch, this.cursor)
    if (batch.length === 0) return
    const values: unknown[] = []
    const placeholders = batch.map((event, index) => {
      values.push(this.id, this.cursor + index, event)
      return `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3}::jsonb)`
    })
    await this.db.query(
      `INSERT INTO agenthub_session_events (session_id, seq, event) VALUES ${placeholders.join(', ')}`,
      values,
    )
    await this.db.query(
      'UPDATE agenthub_sessions SET event_count = event_count + $2, updated_at = now() WHERE id = $1',
      [this.id, batch.length],
    )
    this.cursor += batch.length
  }

  flush(options?: SessionHandleFlushOptions): Promise<void> {
    options?.signal?.throwIfAborted()
    if (this.closed) return Promise.reject(new SessionHandleClosedError(this.id, 'flush'))
    if (this.access !== 'write') return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
    // append 解析即持久，主表行在 create 时已 materialize：屏障为空操作。
    return Promise.resolve()
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    if (this.access === 'write') this.owners.delete(this.id)
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation)
  }
}
