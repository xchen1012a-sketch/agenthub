import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import { asProjectId, asUserId, asWorkspaceId, type ProjectId, type UserId } from '@agenthub/_shared'
import { ProjectService } from '../src/index.ts'
import type { PostgresProjectRepository } from '../src/index.ts'
import { PostgresProjectRepository as ConcreteRepository, type PgPool, type PgPoolClient } from '../src/index.ts'
import type { CreateProjectInput, MemberRole, ProjectRecord, ProjectRow, Queryable } from '../src/index.ts'
import { projectWorkspacePath, resolveWorkspaceRoot, type OpenedWorkspace, type WorkspaceGateway } from '../src/index.ts'

/** 假仓储：不触 DB，按脚本回放（服务层纯逻辑单测）。 */
class FakeRepository {
  readonly inserted: { input: CreateProjectInput; workspaceId: string; projectId: ProjectId }[] = []
  private nextId = 0

  async insertProjectWithWorkspace(
    input: CreateProjectInput,
    projectId: ProjectId,
    resolveWorkspace: () => Promise<string>,
  ): Promise<ProjectRecord> {
    const workspaceId = await resolveWorkspace()
    this.inserted.push({ input, workspaceId, projectId })
    this.nextId += 1
    return {
      id: projectId,
      name: input.name,
      description: input.description ?? null,
      status: 'active',
      harnessWorkspaceId: asWorkspaceId(workspaceId),
      createdBy: input.userId,
      createdAt: '2026-09-27T00:00:00.000Z',
    }
  }

  async listByCreator(userId: UserId): Promise<ProjectRecord[]> {
    return this.inserted
      .filter(item => item.input.userId === userId)
      .map((item, index) => ({
        id: item.projectId,
        name: item.input.name,
        description: null,
        status: 'active' as const,
        harnessWorkspaceId: asWorkspaceId(item.workspaceId),
        createdBy: item.input.userId,
        createdAt: `2026-09-2${index}T00:00:00.000Z`,
      }))
  }

  async findById(projectId: ProjectId): Promise<ProjectRecord | null> {
    const hit = this.inserted.find(item => item.projectId === projectId)
    if (hit === undefined) return null
    return {
      id: hit.projectId,
      name: hit.input.name,
      description: null,
      status: 'active',
      harnessWorkspaceId: asWorkspaceId(hit.workspaceId),
      createdBy: hit.input.userId,
      createdAt: '2026-09-27T00:00:00.000Z',
    }
  }

  async memberRole(projectId: ProjectId, userId: UserId): Promise<MemberRole | null> {
    const hit = this.inserted.find(item => item.projectId === projectId)
    if (hit === undefined) return null
    return hit.input.userId === userId ? 'admin' : null
  }

  async rebindWorkspace(projectId: ProjectId, workspaceId: string): Promise<void> {
    const hit = this.inserted.find(item => item.projectId === projectId)
    if (hit !== undefined) hit.workspaceId = workspaceId
  }
}

/** 假 WorkspaceGateway：固定返回 id，记录调用路径与 title（不碰真实 registry）。 */
class FakeGateway implements WorkspaceGateway {
  readonly calls: { directory: string; title: string }[] = []

  constructor(private readonly id: string = 'ws-fake-0001') {}

  async ensureWorkspace(directory: string, title: string): Promise<string> {
    this.calls.push({ directory, title })
    return this.id
  }

  async resolveChatWorkspace(directory: string, title: string): Promise<OpenedWorkspace> {
    this.calls.push({ directory, title })
    return { id: this.id, path: directory }
  }
}

/** 恒失败的 gateway：驱动"Workspace 创建失败 → 整体失败"路径。 */
class RejectingGateway implements WorkspaceGateway {
  async ensureWorkspace(): Promise<string> {
    throw new Error('registry 不可用')
  }

  async resolveChatWorkspace(): Promise<OpenedWorkspace> {
    throw new Error('registry 不可用')
  }
}

function wired(gateway: WorkspaceGateway = new FakeGateway(), root = 'C:\\agenthub-workspaces') {
  const repository = new FakeRepository()
  const events: { event: string; payload: unknown }[] = []
  const service = new ProjectService(
    repository as unknown as PostgresProjectRepository,
    gateway,
    (event, payload) => {
      events.push({ event, payload })
    },
    { root },
  )
  return { repository, gateway, events, service }
}

const USER: UserId = asUserId('11111111-1111-4111-8111-111111111111')
const OTHER: UserId = asUserId('22222222-2222-4222-8222-222222222222')

describe('ProjectService.createProject（P2 方案书 T4 / V3）', () => {
  it('创建成功：真实 workspaceId 回写，路径 <root>/<projectId>，project.created 事件发出', async () => {
    const gateway = new FakeGateway()
    const { repository, events, service } = wired(gateway)
    const record = await service.createProject({ userId: USER, name: '  平台组  ' }, 'tid-1')
    expect(record.name).toBe('平台组')
    expect(record.harnessWorkspaceId).toBe('ws-fake-0001')
    expect(repository.inserted).toHaveLength(1)
    const call = gateway.calls[0]
    expect(call?.title).toBe('平台组')
    expect(call?.directory).toBe(projectWorkspacePath('C:\\agenthub-workspaces', record.id))
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { projectId: string; createdBy: string; name: string }
    expect(payload.projectId).toBe(record.id)
    expect(payload.createdBy).toBe(USER)
    expect(payload.name).toBe('平台组')
    expect(events[0]?.event).toBe('agenthub/project.created')
  })

  it('Workspace 创建失败：错误上抛，不发 project.created 事件', async () => {
    const { events, service } = wired(new RejectingGateway())
    await expect(service.createProject({ userId: USER, name: 'P1' }, 'tid-1')).rejects.toThrow(/registry 不可用/)
    expect(events).toHaveLength(0)
  })

  it('名称空白 / 超长被拒（422，code agenthub/project/InvalidName），不触 gateway', async () => {
    const gateway = new FakeGateway()
    const { service } = wired(gateway)
    for (const name of ['   ', 'x'.repeat(201)]) {
      await expect(service.createProject({ userId: USER, name }, 'tid-1')).rejects.toMatchObject({
        code: 'agenthub/project/InvalidName',
        httpStatus: 422,
      })
    }
    expect(gateway.calls).toHaveLength(0)
  })
})

describe('ProjectService.resolveProjectContext（跨 Project 隔离）', () => {
  it('成员拿到 context（projectId + workspaceId + role + name）', async () => {
    const { service } = wired()
    const record = await service.createProject({ userId: USER, name: 'P1' }, 'tid-1')
    const context = await service.resolveProjectContext(USER, record.id)
    expect(context).toEqual({
      projectId: record.id,
      workspaceId: record.harnessWorkspaceId,
      role: 'admin',
      name: 'P1',
    })
  })

  it('非成员 403（project_isolation：看不到他人在 Project 里的资源）', async () => {
    const { service } = wired()
    const record = await service.createProject({ userId: USER, name: 'P1' }, 'tid-1')
    await expect(service.resolveProjectContext(OTHER, record.id)).rejects.toMatchObject({
      code: 'agenthub/project/NotMember',
      httpStatus: 403,
    })
  })

  it('不存在的 Project 404（不泄露存在性之外的信息）', async () => {
    const { service } = wired()
    await expect(service.resolveProjectContext(USER, asProjectId('33333333-3333-4333-8333-333333333333')))
      .rejects
      .toMatchObject({ code: 'agenthub/project/NotFound', httpStatus: 404 })
  })

  it('listProjects 只返回创建者本人的 Project', async () => {
    const { service } = wired()
    await service.createProject({ userId: USER, name: 'A' }, 'tid-1')
    await service.createProject({ userId: OTHER, name: 'B' }, 'tid-2')
    const mine = await service.listProjects(USER)
    expect(mine.map(project => project.name)).toEqual(['A'])
  })
})

describe('ProjectService.prepareChatWorkspace', () => {
  it('登记还在时沿用原编号', async () => {
    const { service } = wired()
    const record = await service.createProject({ userId: USER, name: 'P1' }, 'tid-1')
    const opened = await service.prepareChatWorkspace(USER, record.id)
    expect(opened.workspaceId).toBe(record.harnessWorkspaceId)
    expect(opened.workspacePath).toBe(projectWorkspacePath('C:\\agenthub-workspaces', record.id))
  })

  it('登记丢了就改记现在的编号', async () => {
    const gateway = new FakeGateway('ws-old')
    gateway.resolveChatWorkspace = async (directory) => ({ id: 'ws-live', path: directory })
    const { service, repository } = wired(gateway)
    const record = await service.createProject({ userId: USER, name: 'P1' }, 'tid-1')
    const opened = await service.prepareChatWorkspace(USER, record.id)
    expect(opened.workspaceId).toBe('ws-live')
    expect(repository.inserted[0]?.workspaceId).toBe('ws-live')
  })

  it('非成员不能进入', async () => {
    const { service } = wired()
    const record = await service.createProject({ userId: USER, name: 'P1' }, 'tid-1')
    await expect(service.prepareChatWorkspace(OTHER, record.id)).rejects.toMatchObject({
      code: 'agenthub/project/NotMember',
    })
  })
})

describe('projectWorkspacePath / resolveWorkspaceRoot（P2 方案书 §4.2 路径约定）', () => {
  it('路径为 <root>/<projectId>', () => {
    expect(projectWorkspacePath('C:\\ws', asProjectId('44444444-4444-4444-8444-444444444444'))).toBe(
      'C:\\ws\\44444444-4444-4444-8444-444444444444',
    )
  })

  it('AGENTHUB_WORKSPACE_ROOT 优先；缺省回退 <cwd>/.agenthub-workspaces', () => {
    expect(resolveWorkspaceRoot({ AGENTHUB_WORKSPACE_ROOT: 'D:\\data\\ws' })).toBe('D:\\data\\ws')
    expect(resolveWorkspaceRoot({})).toBe(join(process.cwd(), '.agenthub-workspaces'))
  })
})

describe('PostgresProjectRepository.rowToRecord', () => {
  it('DB 行 → 领域视角（branded id / ISO 时间）', async () => {
    const row: ProjectRow = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'DB',
      description: null,
      status: 'active',
      harness_workspace_id: 'ws-db-0001',
      created_by: '11111111-1111-4111-8111-111111111111',
      created_at: new Date('2026-09-27T00:00:00Z'),
    }
    const db: Queryable = {
      async query<R extends QueryResultRow>(text: string): Promise<Pick<QueryResult<R>, 'rows'>> {
        return { rows: (text.includes('FROM projects WHERE id') ? [row] : []) as unknown as R[] }
      },
    }
    const repository = new ConcreteRepository(db)
    const record = await repository.findById(asProjectId('55555555-5555-4555-8555-555555555555'))
    expect(record?.harnessWorkspaceId).toBe('ws-db-0001')
    expect(record?.createdAt).toBe('2026-09-27T00:00:00.000Z')
  })
})

/**
 * 假 pg.Pool：捕获 connect()/client.query()/client.release() 的调用序列，
 * 用于断言两阶段事务包裹与回滚路径（不触真 DB）。
 */
function recordingPool(opts: { workspaceCreateFails?: boolean; emptyWriteBack?: boolean } = {}): {
  pool: PgPool
  log: string[]
} {
  const log: string[] = []
  const pendingRow: ProjectRow = {
    id: '77777777-7777-4777-8777-777777777777',
    name: 'tx',
    description: null,
    status: 'active',
    harness_workspace_id: 'pending:77777777-7777-4777-8777-777777777777',
    created_by: '11111111-1111-4111-8111-111111111111',
    created_at: new Date('2026-09-27T00:00:00Z'),
  }
  const writtenRow: ProjectRow = { ...pendingRow, harness_workspace_id: 'ws-real-0001' }
  const client: PgPoolClient = {
    async query<R extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<Pick<QueryResult<R>, 'rows'>> {
      log.push(
        text.includes('BEGIN')
          ? 'BEGIN'
          : text.includes('COMMIT')
            ? 'COMMIT'
            : text.includes('ROLLBACK')
              ? 'ROLLBACK'
              : text.includes('INSERT INTO projects')
                ? 'INSERT projects'
                : text.includes('INSERT INTO project_members')
                  ? 'INSERT project_members'
                  : text.includes('UPDATE projects')
                    ? `UPDATE workspace:${values?.[1]}`
                    : `query:${text.slice(0, 32)}`,
      )
      if (text.includes('UPDATE projects')) {
        if (opts.emptyWriteBack === true) return { rows: [] as R[] }
        return { rows: [writtenRow as unknown as R] }
      }
      if (text.includes('INSERT INTO projects')) {
        return { rows: [pendingRow as unknown as R] }
      }
      return { rows: [] as R[] }
    },
    release() {
      log.push('release')
    },
  }
  return {
    pool: {
      async query<R extends QueryResultRow>(text: string): Promise<Pick<QueryResult<R>, 'rows'>> {
        log.push(`pool.query:${text.slice(0, 24)}`)
        return { rows: [] as R[] }
      },
      async connect(): Promise<PgPoolClient> {
        log.push('connect')
        return client
      },
    },
    log,
  }
}

describe('PostgresProjectRepository.insertProjectWithWorkspace 两阶段事务（P2 方案书 T4）', () => {
  const PROJECT = asProjectId('77777777-7777-4777-8777-777777777777')

  it('成功路径：BEGIN → INSERT×2 → workspace 创建 → UPDATE 回写 → COMMIT → release', async () => {
    const { pool, log } = recordingPool()
    const repository = new ConcreteRepository(pool)
    const record = await repository.insertProjectWithWorkspace(
      { userId: USER, name: 'tx' },
      PROJECT,
      async () => asWorkspaceId('ws-real-0001'),
    )
    expect(record.harnessWorkspaceId).toBe('ws-real-0001')
    expect(log).toEqual([
      'connect',
      'BEGIN',
      'INSERT projects',
      'INSERT project_members',
      'UPDATE workspace:ws-real-0001',
      'COMMIT',
      'release',
    ])
  })

  it('Workspace 创建失败：ROLLBACK + release，pending 行不留库，原错误上抛', async () => {
    const { pool, log } = recordingPool()
    const repository = new ConcreteRepository(pool)
    await expect(
      repository.insertProjectWithWorkspace(
        { userId: USER, name: 'tx' },
        PROJECT,
        async () => {
          throw new Error('registry 不可用')
        },
      ),
    ).rejects.toThrow(/registry 不可用/)
    expect(log).toEqual([
      'connect',
      'BEGIN',
      'INSERT projects',
      'INSERT project_members',
      'ROLLBACK',
      'release',
    ])
  })

  it('回写命中 0 行视为异常 → ROLLBACK（fail-fast，不带 pending 提交）', async () => {
    const { pool, log } = recordingPool({ emptyWriteBack: true })
    const repository = new ConcreteRepository(pool)
    await expect(
      repository.insertProjectWithWorkspace({ userId: USER, name: 'tx' }, PROJECT, async () => asWorkspaceId('ws-real-0001')),
    ).rejects.toThrow(/write-back returned no row/)
    expect(log).toContain('ROLLBACK')
    expect(log).not.toContain('COMMIT')
  })
})

/**
 * 1:1 唯一约束集成测试（P2 方案书 T4：重复 harness_workspace_id 插入报错）。
 * 方案书原文为 testcontainers；仓库无该依赖，改为经 AGENTHUB_TEST_DATABASE_URL
 * 连本机 PostgreSQL（未设置时整组跳过），断言 0002 迁移的 UNIQUE 约束真实生效。
 */
const integrationUrl = process.env.AGENTHUB_TEST_DATABASE_URL
describe.skipIf(integrationUrl === undefined)('projects.harness_workspace_id UNIQUE（1:1 集成）', () => {
  it('重复 workspace_id 第二次插入报 23505', async () => {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: integrationUrl })
    try {
      const itUser = randomUUID()
      const workspaceId = `ws-it-${randomUUID()}`
      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash)
         VALUES ($1, $2, 'it-tmp', 'it-tmp') ON CONFLICT (id) DO NOTHING`,
        [itUser, `it-tmp-${itUser}@agenthub.local`],
      )
      const first = await pool.query(
        `INSERT INTO projects (id, name, harness_workspace_id, created_by)
         VALUES ($1, 'it-a', $2, $3)`,
        [randomUUID(), workspaceId, itUser],
      )
      expect(first.rowCount).toBe(1)
      await expect(
        pool.query(
          `INSERT INTO projects (id, name, harness_workspace_id, created_by)
           VALUES ($1, 'it-b', $2, $3)`,
          [randomUUID(), workspaceId, itUser],
        ),
      ).rejects.toMatchObject({ code: '23505' })
      await pool.query('DELETE FROM projects WHERE harness_workspace_id = $1', [workspaceId])
      await pool.query('DELETE FROM users WHERE id = $1', [itUser])
    } finally {
      await pool.end()
    }
  })
})
