/**
 * Workspace 薄封装（P2 方案书 T5：不新建包，收敛在本文件）。
 *
 * 仅触碰上游 `ctx.workspaceRegistry` 公开面（upstream-seams §2）：
 * `create(path, title?)` 要求目录已存在、canonical 路径幂等返回同一 Workspace。
 * Project ↔ Workspace 1:1（.ai-spec 10-architecture.md ARCH-4），路径约定见 P2 方案书 §4.2：
 * `<AGENTHUB_WORKSPACE_ROOT>/<projectId>`，title 用 Project 名。
 *
 * @module @agenthub/project/workspace
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceId, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** 对话可以进入的工作区：编号必须是当前注册表里的，路径给对话侧认领。 */
export interface OpenedWorkspace {
  readonly id: string
  readonly path: string
}

/** Workspace 创建门面（测试用假实现替代，避免碰真实文件系统与上游 registry）。 */
export interface WorkspaceGateway {
  /** 目录不存在则递归创建；返回 harness Workspace id 字符串（同路径幂等）。 */
  ensureWorkspace(directory: string, title: string): Promise<string>
  /**
   * 找到这个项目现在能进入的工作区。登记还在就用原来的；登记丢了就按项目目录重新接上。
   */
  resolveChatWorkspace(directory: string, title: string, currentId: string): Promise<OpenedWorkspace>
}

/** 上游 WorkspaceRegistry 适配器：补齐 `create` 的"目录必须已存在"前置条件。 */
export class HarnessWorkspaceGateway implements WorkspaceGateway {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async ensureWorkspace(directory: string, title: string): Promise<string> {
    const opened = await this.resolveChatWorkspace(directory, title, '')
    return opened.id
  }

  async resolveChatWorkspace(directory: string, title: string, currentId: string): Promise<OpenedWorkspace> {
    if (currentId !== '') {
      const current = this.registry.get(WorkspaceId(currentId))
      if (current !== undefined) return { id: String(current.id), path: current.path }
    }
    await mkdir(directory, { recursive: true })
    try {
      const existing = await this.registry.resolveByPath(directory)
      if (existing !== undefined) return { id: String(existing.id), path: existing.path }
    } catch {
      // 目录还没被登记时 resolveByPath 会拒绝；下面按新工作区创建。
    }
    const workspace = await this.registry.create(directory, title)
    return { id: String(workspace.id), path: workspace.path }
  }
}

/** Project 的 Workspace 目录路径：`<root>/<projectId>`（P2 方案书 §4.2）。 */
export function projectWorkspacePath(root: string, projectId: string): string {
  return join(root, projectId)
}

/**
 * Workspace 根目录（非敏感配置 `AGENTHUB_WORKSPACE_ROOT`，P2 方案书 §4.2）。
 * 缺省回退 `<cwd>/.agenthub-workspaces/`（cwd 即 deepseek-harness 仓库根，
 * 该目录已加入 .gitignore）。
 */
export function resolveWorkspaceRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.AGENTHUB_WORKSPACE_ROOT?.trim()
  return configured !== undefined && configured !== '' ? configured : join(process.cwd(), '.agenthub-workspaces')
}
