/**
 * 工具调用需要员工先登录外部系统时抛出的错误。
 *
 * 继承上游 HarnessError：工具执行链只把 HarnessError 的 `code` 写进工具结果，
 * 对话里的工具视图靠这个 code 认出「要登录」，再向平台查询登录状态。
 * 消息会进入模型可见的工具结果，只写系统名与下一步，不含任何凭证。
 *
 * @module @agenthub/system-connector/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** 工具结果里的错误码；客户端工具视图按同一字面值识别。 */
export const LOGIN_REQUIRED_CODE = 'AGENTHUB_LOGIN_REQUIRED'

export class LoginRequiredError extends HarnessError {
  constructor(connectionName: string, toolName: string, expired: boolean) {
    const state = expired ? '登录已失效' : '尚未登录'
    super(
      `${state}「${connectionName}」，无法调用 ${toolName}。请在对话中的登录卡片完成登录，然后让我继续。`,
      LOGIN_REQUIRED_CODE,
    )
  }
}
