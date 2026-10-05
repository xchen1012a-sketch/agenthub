/**
 * OpenAPI 扫描任务状态（P5 增强：可见进度 + 关闭弹窗后状态保持）。
 *
 * 为什么需要它：导入是"拉文档 → 逐 operation 落库 → （可选）逐个模型判级"，
 * 940 个 operation 且开判级时会跑很久。原先浏览器只能发一个 POST 然后干等，
 * 既看不到进度，关闭页面后也无从得知结果。
 *
 * 本模块把任务状态放在**服务端进程内**，因此：
 *   - 弹窗订阅事件即可看到真实阶段与计数（不是假的百分比）；
 *   - 弹窗关掉、页面刷新后，重新订阅仍能拿到当前状态与上次结果。
 *
 * 边界（如实声明）：状态是**进程内**的，进程重启即丢失；它不是跨实例的任务队列。
 * 若将来要多实例部署或跨重启续跑，需换成持久化任务表 —— 当前的可见性需求不需要它。
 *
 * @module @agenthub/openapi-ingest/progress
 */

/** 扫描阶段（顺序推进；`failed` 为终止态）。 */
export type ScanPhase = 'fetching' | 'parsing' | 'grading' | 'writing' | 'done' | 'failed'

/** 一个扫描任务的对外状态。 */
export interface ScanProgress {
  readonly connectionId: string
  readonly phase: ScanPhase
  /** 本阶段已处理数量（`parsing` 之后为 operation 数）。 */
  readonly processed: number
  /** 本次预计总数；`fetching` 阶段尚不可知时为 `null`（此时不显示百分比）。 */
  readonly total: number | null
  /** 失败原因（`failed` 阶段）。 */
  readonly reason?: string
  /** 结束时写入的工具数。 */
  readonly created?: number
  readonly skipped?: number
  readonly startedAt: string
  readonly finishedAt?: string
}

/** 订阅者回调。 */
export type ScanListener = (progress: ScanProgress) => void

/**
 * 进程内扫描任务注册表。
 *
 * 每个连接同时只允许一个扫描在跑：重复点击「扫描」不应并发拉取同一份文档。
 * 订阅者断开（弹窗关闭）不影响任务继续执行，这正是"关闭后状态保持"的实现方式。
 */
export class ScanRegistry {
  private readonly states = new Map<string, ScanProgress>()
  private readonly listeners = new Map<string, Set<ScanListener>>()

  /**
   * 读取一个连接的当前（或最近一次）扫描状态。
   * @param connectionId - 连接 id。
   * @returns 状态；从未扫描过时为 `undefined`。
   */
  get(connectionId: string): ScanProgress | undefined {
    return this.states.get(connectionId)
  }

  /** 该连接此刻是否正在扫描（用于拒绝并发重复扫描）。 */
  isRunning(connectionId: string): boolean {
    const phase = this.states.get(connectionId)?.phase
    return phase !== undefined && phase !== 'done' && phase !== 'failed'
  }

  /**
   * 订阅某连接的扫描状态变化。
   *
   * 立即回放一次当前状态（若有），使"打开弹窗时任务已在跑"的场景无需等下一次事件。
   * @param connectionId - 连接 id。
   * @param listener - 回调。
   * @returns 取消订阅函数。
   */
  subscribe(connectionId: string, listener: ScanListener): () => void {
    let set = this.listeners.get(connectionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(connectionId, set)
    }
    set.add(listener)
    const current = this.states.get(connectionId)
    if (current !== undefined) listener(current)
    return () => { set.delete(listener) }
  }

  /**
   * 更新状态并广播。
   * @param progress - 完整的新状态（调用方负责保留既有字段）。
   */
  publish(progress: ScanProgress): void {
    this.states.set(progress.connectionId, progress)
    for (const listener of this.listeners.get(progress.connectionId) ?? []) listener(progress)
  }
}
