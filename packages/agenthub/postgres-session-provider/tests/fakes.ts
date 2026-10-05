/**
 * 测试假实现：有状态内存 DB，按 provider 的 6 类 SQL 形状回放
 * agenthub_sessions / agenthub_session_events 表语义（不触真实 PostgreSQL）。
 *
 * @module tests/fakes
 */
interface FakeSessionRow {
  readonly header: unknown
  inherited_event_count: number
  event_count: number
}

export class SessionFakeDb {
  readonly statements: { text: string; values?: readonly unknown[] }[] = []
  readonly sessions = new Map<string, FakeSessionRow>()
  /** session_id → (seq → event)。 */
  readonly events = new Map<string, Map<number, unknown>>()

  async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push({ text, ...(values !== undefined ? { values } : {}) })
    // INSERT 主表：values = [id, version, header, inherited]；模拟 PK 冲突。
    if (text.includes('INSERT INTO agenthub_sessions')) {
      const [id, , header, inherited] = values as [string, number, unknown, number]
      if (this.sessions.has(id)) return { rows: [] }
      this.sessions.set(id, { header, inherited_event_count: inherited, event_count: 0 })
      return { rows: [{ id }] }
    }
    // SELECT 主表（单行 / 列表）。
    if (text.startsWith('SELECT header, inherited_event_count, event_count FROM agenthub_sessions')) {
      const pool = text.includes('WHERE id = $1') ? this.filterById(values?.[0] as string) : [...this.sessions.entries()]
      return {
        rows: pool.map(([id, row]) => ({
          id,
          header: row.header,
          inherited_event_count: String(row.inherited_event_count),
          event_count: String(row.event_count),
        })),
      }
    }
    // 批量插事件：values = [id, seq, event] × n；seq 冲突模拟 PK 冲突。
    if (text.includes('INSERT INTO agenthub_session_events')) {
      const list = values ?? []
      for (let index = 0; index < list.length; index += 3) {
        const [id, seq, event] = [list[index] as string, list[index + 1] as number, list[index + 2]]
        let log = this.events.get(id)
        if (log === undefined) {
          log = new Map()
          this.events.set(id, log)
        }
        if (log.has(seq)) throw new Error(`duplicate key value violates unique constraint "agenthub_session_events_pkey" (seq ${seq})`)
        log.set(seq, event)
      }
      return { rows: [] }
    }
    // 读事件切片：values = [id, from]（+ limit）。
    if (text.startsWith('SELECT event FROM agenthub_session_events')) {
      const id = values?.[0] as string
      const from = values?.[1] as number
      const limit = text.includes('LIMIT $3') ? values?.[2] as number : Number.POSITIVE_INFINITY
      const log = this.events.get(id)
      const rows: Record<string, unknown>[] = []
      if (log !== undefined) {
        for (const seq of [...log.keys()].sort((a, b) => a - b)) {
          if (seq < from || rows.length >= limit) continue
          rows.push({ event: log.get(seq) })
        }
      }
      return { rows }
    }
    // 回写 event_count：values = [id, delta]。
    if (text.includes('UPDATE agenthub_sessions SET event_count')) {
      const [id, delta] = values as [string, number]
      const row = this.sessions.get(id)
      if (row !== undefined) row.event_count += delta
      return { rows: [] }
    }
    throw new Error(`SessionFakeDb: 未识别的语句形状: ${text}`)
  }

  private filterById(id: string): [string, FakeSessionRow][] {
    const row = this.sessions.get(id)
    return row === undefined ? [] : [[id, row]]
  }
}
