/**
 * 测试假实现（plugin.spec / service.spec 共用）。
 *
 * @module tests/fakes
 */
/** 假 DB：捕获语句并按形状回放（不触真实 PostgreSQL）。 */
export class FakeDb {
  readonly statements: { text: string; values?: readonly unknown[] }[] = []
  /** 可选闸门：INSERT 返回前 await（复现 C-6 before 尚未落库时 denied 先到）。 */
  beforeInsert?: () => Promise<void>

  constructor(private readonly toolRow: Record<string, unknown> | null = { id: 'tool-0001', risk_level: 'read' }) {}

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push({ text, ...(values !== undefined ? { values } : {}) })
    if (text.startsWith('INSERT INTO audit_records') && this.beforeInsert !== undefined) {
      await this.beforeInsert()
    }
    if (text.includes('RETURNING id')) return { rows: [{ id: 'audit-0001' }] }
    if (text.startsWith('SELECT id, risk_level')) return { rows: this.toolRow === null ? [] : [this.toolRow] }
    return { rows: [] }
  }
}
