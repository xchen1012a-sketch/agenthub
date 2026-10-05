/**
 * Project 领域服务（阶段书 §3.1 #10 / P2 方案书 T4）。
 *
 * P2 起 Project ↔ Harness Workspace 1:1：createProject 先插 projects 行
 * （pending 占位），再经 WorkspaceGateway 建 `<root>/<projectId>` 真实
 * Workspace，回写 `harness_workspace_id`；任一步失败整体回滚。
 *
 * @module @agenthub/project/service
 */
import { randomUUID } from 'node:crypto'
import {
  AGENTHUB_EVENTS,
  AgenthubError,
  asProjectId,
  asWorkspaceId,
  createLogger,
  type Logger,
  type ProjectCreatedPayload,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from '@agenthub/_shared'
import type { PostgresProjectRepository } from './repository.ts'
import type { CreateProjectInput, MemberRole, ProjectContext, ProjectRecord } from './types.ts'
import { projectWorkspacePath, resolveWorkspaceRoot, type WorkspaceGateway } from './workspace.ts'

/** Project 创建事件发散发器（Cordis ctx.emit 的注入点，测试用收集器替代）。 */
export type EventEmitter = (event: typeof AGENTHUB_EVENTS.projectCreated, payload: ProjectCreatedPayload) => void

const NAME_MAX = 200

export class ProjectService {
  private readonly logger: Logger
  private readonly root: string

  constructor(
    private readonly repository: PostgresProjectRepository,
    private readonly gateway: WorkspaceGateway,
    private readonly emit: EventEmitter,
    options: { root?: string; logger?: Logger } = {},
  ) {
    this.root = options.root ?? resolveWorkspaceRoot()
    this.logger = options.logger ?? createLogger('agenthub/project')
  }

  /**
   * 创建 Project（V3：DB 行 +1，harness_workspace_id 为真实 Workspace ID）。
   * 两阶段（P2 方案书 T4）：INSERT pending → gateway.create → UPDATE 回写，
   * 全程单事务，失败 ROLLBACK（repository 内实现）。
   * @param traceId 请求级 traceId（OBS-1：随业务日志贯穿）。
   * @throws AgenthubError `agenthub/project/InvalidName`（422）名称为空或超长。
   */
  async createProject(input: CreateProjectInput, traceId: string | null): Promise<ProjectRecord> {
    const name = input.name.trim()
    if (name.length === 0 || name.length > NAME_MAX) {
      throw new AgenthubError(
        'agenthub/project/InvalidName',
        `Project 名称需为 1-${NAME_MAX} 个字符`,
        { httpStatus: 422 },
      )
    }
    const projectId = asProjectId(randomUUID())
    const record = await this.repository.insertProjectWithWorkspace(
      { ...input, name },
      projectId,
      async () => asWorkspaceId(await this.gateway.ensureWorkspace(projectWorkspacePath(this.root, projectId), name)),
    )
    this.emit(AGENTHUB_EVENTS.projectCreated, {
      projectId: record.id,
      workspaceId: record.harnessWorkspaceId,
      createdBy: record.createdBy,
      name: record.name,
    })
    this.logger.info(
      {
        event: 'project.created',
        projectId: record.id,
        userId: record.createdBy,
        traceId,
        sessionId: null,
      },
      { workspaceId: record.harnessWorkspaceId },
    )
    return record
  }

  /** 创建者视角列表（P1：仅本人创建；P2 扩展 project_members 全量）。 */
  async listProjects(userId: UserId): Promise<ProjectRecord[]> {
    return this.repository.listByCreator(userId)
  }

  /** 按 Harness Workspace 反查项目。对不上返回 null，调用方不得改猜别的项目。 */
  async findByWorkspaceId(workspaceId: WorkspaceId): Promise<ProjectRecord | null> {
    return this.repository.findByWorkspaceId(workspaceId)
  }

  /**
   * 准备进入这个项目的对话。成员才可以。登记还在就沿用；丢了就按项目目录重新接上，
   * 并把项目记下的编号改成现在这个，避免对话侧拿着过期编号去开会话。
   */
  async prepareChatWorkspace(userId: UserId, projectId: ProjectId): Promise<{ workspaceId: string; workspacePath: string }> {
    await this.resolveProjectContext(userId, projectId)
    const record = await this.repository.findById(projectId)
    if (record === null) {
      throw new AgenthubError('agenthub/project/NotFound', 'Project 不存在', { httpStatus: 404 })
    }
    const opened = await this.gateway.resolveChatWorkspace(
      projectWorkspacePath(this.root, projectId),
      record.name,
      record.harnessWorkspaceId,
    )
    if (opened.id !== record.harnessWorkspaceId) {
      await this.repository.rebindWorkspace(projectId, asWorkspaceId(opened.id))
    }
    return { workspaceId: opened.id, workspacePath: opened.path }
  }

  /**
   * 成员校验 + 上下文解析（跨 Project 隔离核心，.ai-spec 20-security.md BND-3 fail-closed）。
   * @throws AgenthubError `agenthub/project/NotFound`（404）不存在；
   * @throws AgenthubError `agenthub/project/NotMember`（403）非成员。
   */
  async resolveProjectContext(userId: UserId, projectId: ProjectId): Promise<ProjectContext> {
    const record = await this.repository.findById(projectId)
    if (record === null) {
      throw new AgenthubError('agenthub/project/NotFound', 'Project 不存在', { httpStatus: 404 })
    }
    const role: MemberRole | null = await this.repository.memberRole(projectId, userId)
    if (role === null) {
      throw new AgenthubError('agenthub/project/NotMember', '你不是该 Project 的成员', { httpStatus: 403 })
    }
    // 名字与角色一同携带，避免 P0 阶段 UI 详情页另起一次 listProjects().find（避免 N+1 与跨成员可见性耦合）。
    return { projectId: record.id, workspaceId: record.harnessWorkspaceId, role, name: record.name }
  }
}
