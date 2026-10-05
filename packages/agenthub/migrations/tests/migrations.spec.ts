import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 迁移静态守护（.ai-spec 30-data.md DATA-3 迁移规范 / U6）
 * 真实数据库行为（up / status 幂等 / 约束生效）由部署验证流程覆盖，不在此处。
 */
const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql')

// U6（MUST）：NNNN_<package>_<name>.sql，包前缀必填，小写连字符下划线
const U6_FILENAME = /^(\d{4})_migrations_[a-z_]+\.sql$/

function unquotedExtensionNames(sql: string): string[] {
  return [...sql.matchAll(/(?:CREATE|DROP) EXTENSION (?:IF (?:NOT )?EXISTS )?([^\s(,;]+)/gi)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined && !name.startsWith('"'))
}

describe('迁移文件命名与结构', () => {
  it('目录内全部文件符合 U6 命名且编号严格递增', async () => {
    const files = (await readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort()
    expect(files.length).toBeGreaterThan(0)

    let prev = 0
    for (const file of files) {
      const match = U6_FILENAME.exec(file)
      expect(match, `文件 ${file} 不符合 U6 命名 NNNN_<package>_<name>.sql`).not.toBeNull()
      const seq = Number(match?.[1])
      expect(seq, `编号 ${seq} 必须严格递增（前一个 ${prev}）`).toBeGreaterThan(prev)
      prev = seq
    }
  })

  it('每个迁移恰含一对 migrate 块，且 up 在 down 之前', async () => {
    const files = (await readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), 'utf8')
      const upCount = content.split('-- migrate:up').length - 1
      const downCount = content.split('-- migrate:down').length - 1
      expect(upCount, `${file} 的 migrate:up 块数量必须为 1`).toBe(1)
      expect(downCount, `${file} 的 migrate:down 块数量必须为 1`).toBe(1)
      expect(content.indexOf('-- migrate:up'), `${file} 的 up 块必须在 down 之前`)
        .toBeLessThan(content.indexOf('-- migrate:down'))
    }
  })

  it('up 块禁止 DROP TABLE / DROP SCHEMA（v1 不 DROP，.ai-spec 30-data.md DATA-3）', async () => {
    const files = (await readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), 'utf8')
      const upBlock = content.split('-- migrate:down')[0]
      expect(upBlock, `${file} 的 up 块不得包含 DROP TABLE`).not.toMatch(/DROP TABLE/i)
      expect(upBlock, `${file} 的 up 块不得包含 DROP SCHEMA`).not.toMatch(/DROP SCHEMA/i)
    }
  })

  it('down 块非空（UP+DOWN 成对可回滚）', async () => {
    const files = (await readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const downBlock = (await readFile(path.join(sqlDir, file), 'utf8')).split('-- migrate:down')[1] ?? ''
      expect(downBlock.trim(), `${file} 的 down 块不得为空`).not.toBe('')
    }
  })
})

describe('表结构规范（.ai-spec 30-data.md DATA-3 MUST）', () => {
  it('每张业务表主键为 UUID DEFAULT gen_random_uuid() 且含 created_at TIMESTAMPTZ', async () => {
    const files = (await readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort()
    let tableCount = 0
    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), 'utf8')
      for (const match of content.matchAll(/CREATE TABLE (\w+)\s*\((.*?)\n\);/gs)) {
        const table = match[1]
        const body = match[2]
        if (!table || !body) continue
        tableCount += 1
        // agenthub_sessions 主键为 Harness Session ID TEXT（P2 方案书 T8/D4 定稿：
        // 以 SessionPersistence 真实契约为准，事件表 (session_id, seq) 复合 PK）
        const isHarnessSession = table === 'agenthub_sessions'
        // 单列主键表用 UUID 默认值；关联表（user_roles / project_members）按规范用复合 PK
        const hasUuidPk = /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/.test(body)
        const hasCompositePk = /PRIMARY KEY \(\w+, \w+\)/.test(body)
        expect(isHarnessSession || hasUuidPk || hasCompositePk, `${table} 必须有 UUID 主键或复合主键`).toBe(true)
        // project_members 按规范 §3.2 用 joined_at 表达创建时间（语义等价 created_at）
        expect(body, `${table} 必须含 TIMESTAMPTZ NOT NULL DEFAULT now() 的时间戳列`)
          .toMatch(/(created_at|joined_at) TIMESTAMPTZ NOT NULL DEFAULT now\(\)/)
      }
    }
    // P1 数据层：users / roles / user_roles / projects / project_members / system_connections
    // P2 数据层：sessions / tools / project_tool_set / audit_records
    //          / agenthub_sessions + agenthub_session_events（P2 T8 Harness Session 持久化）
    // P3 阶段 A：user_credentials / approvals / badcases（0010–0012）
    // P4 阶段 A：project_memories（0014）
    expect(tableCount).toBe(16)
  })

  it('种子数据必须幂等（ON CONFLICT DO NOTHING）', async () => {
    const seed = await readFile(path.join(sqlDir, '0002_migrations_users_roles.sql'), 'utf8')
    expect(seed).toMatch(/INSERT INTO roles[\s\S]*ON CONFLICT \(name\) DO NOTHING/)
  })

  it('projects.system_connection_id 外键必须有独立索引', async () => {
    const files = (await readdir(sqlDir)).filter(file => file.endsWith('.sql')).sort()
    const sql = (await Promise.all(files.map(file => readFile(path.join(sqlDir, file), 'utf8')))).join('\n')
    expect(sql).toMatch(/CREATE INDEX(?: IF NOT EXISTS)? idx_projects_system_connection ON projects\(system_connection_id\)/i)
  })

  it('含连字符的扩展名必须加双引号（uuid-ossp 教训：裸标识符会在 PG 报 syntax error）', async () => {
    const files = (await readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), 'utf8')
      // CREATE/DROP EXTENSION 目标若含 -，必须写成 "name"（去掉引号后匹配裸形式即 fail）
      for (const name of unquotedExtensionNames(content)) {
        expect(name.includes('-'), `${file}: 扩展名 ${name} 含连字符必须加双引号`).toBe(false)
      }
    }
  })

  it('守护会识别未加双引号的连字符扩展名', () => {
    expect(unquotedExtensionNames('CREATE EXTENSION IF NOT EXISTS uuid-ossp;')).toEqual(['uuid-ossp'])
    expect(unquotedExtensionNames('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')).toEqual([])
  })
})

describe('P3 阶段 A 表结构守护（.ai-spec 30-data.md DATA-1+DATA-5/§3.7 / 方案书 D14）', () => {
  const readSql = async (file: string): Promise<string> =>
    readFile(path.join(sqlDir, file), 'utf8')

  it('user_credentials：密文 BYTEA + key_version + (user_id, system_connection_id) 唯一', async () => {
    const sql = await readSql('0010_migrations_user_credentials.sql')
    expect(sql).toMatch(/encrypted_payload BYTEA NOT NULL/)
    expect(sql).toMatch(/key_version INT NOT NULL/)
    expect(sql).toMatch(/UNIQUE \(user_id, system_connection_id\)/)
  })

  it('approvals：status 四态 CHECK + expires_at 默认 now()+1h', async () => {
    const sql = await readSql('0011_migrations_approvals.sql')
    expect(sql).toMatch(/status TEXT NOT NULL(?: DEFAULT 'pending')? CHECK \(status IN \('pending', 'approved', 'rejected', 'expired'\)\)/)
    expect(sql).toMatch(/expires_at TIMESTAMPTZ NOT NULL DEFAULT \(now\(\) \+ INTERVAL '1 hour'\)/)
  })

  it('badcases：category 八态 CHECK', async () => {
    const sql = await readSql('0012_migrations_badcases.sql')
    expect(sql).toMatch(/category TEXT NOT NULL CHECK \(category IN \(/)
    for (const value of ['wrong_tool', 'bad_param', 'upstream_error', 'permission_denied', 'model_misunderstanding', 'prompt_injection', 'timeout', 'unknown']) {
      expect(sql, `category CHECK 缺少 ${value}`).toContain(`'${value}'`)
    }
  })

  it('audit_records 补挂 approval_id（D5）且 auth_mode 扩展 session（D14）', async () => {
    const sql = await readSql('0013_migrations_audit_records_approval_id.sql')
    expect(sql).toMatch(/ADD COLUMN approval_id UUID REFERENCES approvals\(id\) ON DELETE SET NULL/)
    expect(sql).toMatch(/'oauth2', 'oidc', 'api_login', 'pat', 'cookie', 'session'/)
    // down 块必须回滚 auth_mode 到五态
    const downBlock = sql.split('-- migrate:down')[1] ?? ''
    expect(downBlock).toMatch(/'oauth2', 'oidc', 'api_login', 'pat', 'cookie'\)/)
  })
})

describe('P4 阶段 A 表结构守护（.ai-spec 30-data.md DATA-4）', () => {
  const readSql = async (file: string): Promise<string> =>
    readFile(path.join(sqlDir, file), 'utf8')

  it('project_memories：embedding VECTOR(1536) + metadata JSONB + locked BOOL + ivfflat 索引 + 级联外键', async () => {
    const sql = await readSql('0014_migrations_project_memories.sql')
    expect(sql).toMatch(/embedding VECTOR\(1536\) NOT NULL/)
    expect(sql).toMatch(/metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/)
    expect(sql).toMatch(/locked BOOLEAN NOT NULL DEFAULT false/)
    expect(sql).toMatch(/USING ivfflat \(embedding vector_cosine_ops\) WITH \(lists = 100\)/)
    expect(sql).toMatch(/REFERENCES projects\(id\) ON DELETE CASCADE/)
  })

  it('0015 维度迁移：vector(1536) → halfvec(2048) + HNSW；UP+DOWN 成对', async () => {
    const sql = await readSql('0015_migrations_project_memories_dim.sql')
    expect(sql).toMatch(/ALTER TABLE project_memories DROP COLUMN embedding;/)
    // 2048 维超出 vector 的索引上限（2000），必须用 halfvec
    expect(sql).toMatch(/ADD COLUMN embedding halfvec\(2048\) NOT NULL;/)
    expect(sql).toMatch(/USING hnsw \(embedding halfvec_cosine_ops\)/)
    expect(sql).not.toMatch(/vector\(2048\)/)
    // DOWN 必须回到 1536 维 vector + ivfflat，否则回滚后与旧代码不一致。
    const downBlock = sql.slice(sql.indexOf('-- migrate:down'))
    expect(downBlock).toMatch(/ADD COLUMN embedding vector\(1536\) NOT NULL;/)
    expect(downBlock).toMatch(/USING ivfflat \(embedding vector_cosine_ops\) WITH \(lists = 100\)/)
  })
})
