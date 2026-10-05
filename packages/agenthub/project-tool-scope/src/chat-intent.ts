/**
 * 「谁正在打开哪个项目的对话」的短期登记。
 *
 * 上游开会话的事件不带员工身份。员工点「用项目开始对话」时，平台接口已按登录态
 * 核验过身份与成员关系，在这里登记一条；随后新会话落到该项目工作区时取走它，
 * 会话主人就来自这条登记，而不是「最近一次请求的员工」。
 *
 * 同一项目同时有不同员工在等待时无法区分是谁的会话，一律不绑定（BND-4）。
 *
 * @module @agenthub/project-tool-scope/chat-intent
 */

/** 登记从点击到会话创建的最长间隔。 */
export const CHAT_INTENT_TTL_MS = 2 * 60 * 1000

interface Intent {
  readonly userId: string
  readonly expiresAt: number
}

/** 取登记的结果：唯一员工、没有登记、或有多名员工无法区分。 */
export type ChatClaim =
  | { readonly kind: 'owner'; readonly userId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }

export class ChatIntents {
  private readonly byProject = new Map<string, Intent[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** 登记一次打开。调用方须已按服务端登录态核验员工是该项目成员。 */
  expect(projectId: string, userId: string): void {
    const pending = this.live(projectId)
    pending.push({ userId, expiresAt: this.now() + CHAT_INTENT_TTL_MS })
    this.byProject.set(projectId, pending)
  }

  /** 新会话落到该项目时取走一条登记；有多名员工在等待时不取。 */
  claim(projectId: string): ChatClaim {
    const pending = this.live(projectId)
    if (pending.length === 0) {
      this.byProject.delete(projectId)
      return { kind: 'none' }
    }
    const owner = pending[0]?.userId as string
    if (pending.some(intent => intent.userId !== owner)) {
      this.byProject.set(projectId, pending)
      return { kind: 'ambiguous' }
    }
    pending.shift()
    if (pending.length === 0) this.byProject.delete(projectId)
    else this.byProject.set(projectId, pending)
    return { kind: 'owner', userId: owner }
  }

  private live(projectId: string): Intent[] {
    const now = this.now()
    return (this.byProject.get(projectId) ?? []).filter(intent => intent.expiresAt > now)
  }
}
