/**
 * 会话文本提取（P4 方案书阶段 B T4 / D27）。
 *
 * 单个事件的语义文本由上游 `@deepseek-ai/dsh-session-query` 的
 * `extractSessionEventText` 决定（user/assistant message 正文、tool 名与参数、
 * 工具结果、todo、turn 结束原因）；本模块只负责把它们按顺序拼成一段可控长度的
 * 正文，供 LLM 提取记忆候选。
 *
 * 不自行解析事件结构：上游已明确哪些事件面属于"可检索语义"，自造一套会在上游
 * 增删事件类型时静默漂移。
 *
 * @module @agenthub/project-memory/extraction
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'

/** 拼装会话正文的默认字节上限（控制 LLM 输入规模）。 */
export const DEFAULT_SESSION_TEXT_MAX_BYTES = 16_384

/** 省略标记：截断时追加，让模型知道上下文不完整。 */
const TRUNCATION_MARKER = '\n[…更早的对话已省略…]'

/**
 * 把一条会话事件序列拼成正文。
 *
 * 输入事件按原顺序拼接；空文本事件（结构边界、请求信封、未知事件）被跳过。
 * 超出 `maxBytes` 时保留**最近**的部分（尾部），因为"最后达成的结论"比开场白更
 * 可能成为项目记忆，并在开头标注省略。
 *
 * @param events - 会话原始事件（`readSession().events`）。
 * @param maxBytes - 正文字节上限，默认 {@link DEFAULT_SESSION_TEXT_MAX_BYTES}。
 * @returns 拼接后的正文；无可用文本时返回空串。
 */
export function extractSessionText(
  events: readonly SessionEvent[],
  maxBytes: number = DEFAULT_SESSION_TEXT_MAX_BYTES,
): string {
  const joined = events
    .map(event => extractSessionEventText(event).trim())
    .filter(text => text.length > 0)
    .join('\n')
  if (Buffer.byteLength(joined, 'utf8') <= maxBytes) return joined
  return TRUNCATION_MARKER + '\n' + tailWithinBytes(joined, maxBytes)
}

/** 取字符串末尾、不超过给定字节数的字符片段（从合法 UTF-8 边界开始，不切断多字节字符）。 */
function tailWithinBytes(text: string, maxBytes: number): string {
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8') - 1)
  if (budget === 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  let start = Math.max(0, bytes.length - budget)
  // 起点必须落在字符首字节（UTF-8 续字节形如 10xxxxxx），否则解码会产生替换字符。
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8').trimStart()
}

/** 从事件序列里取最后一条用户消息的正文（注入检索的查询向量来源）。 */
export function lastUserMessageText(events: readonly SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const text = extractSessionEventText(event).trim()
    if (text.length > 0) return text
  }
  return null
}
