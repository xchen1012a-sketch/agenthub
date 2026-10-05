/**
 * 测试公用装配：镜像上游 scoped.spec.ts 的 mount/mintAgentScope/run 先例。
 *
 * @module tests/mount
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

/** 挂载 Tool Registry（含 systemPrompt 依赖）到全新 context。 */
export async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

const CALL_SIGNAL = new AbortController().signal

let callSeq = 0

/** 以指定 agent 身份执行一个 Tool，返回首个 text block（unknown tool 时为错误文本）。 */
export async function runTool(ctx: Context, name: string, args: Record<string, unknown>, agent?: object): Promise<string> {
  callSeq += 1
  const result = await ctx.tools.execute({
    signal: CALL_SIGNAL,
    callId: ToolCallId(`c${callSeq}`),
    name,
    arguments: args,
    ...(agent !== undefined ? { agent: agent as never } : {}),
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}
