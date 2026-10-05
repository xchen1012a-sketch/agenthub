/**
 * 凭证脱敏（.ai-spec 40-extension.md EXT-7 MUST / .ai-spec 20-security.md SEC-1–1.4；P1 验收 V5 预热）。
 *
 * ✅ MUST（.ai-spec 20-security.md SEC-1）：禁止正则匹配做脱敏——本文件只用字段名清单
 * （constants.ts 的 SENSITIVE_FIELDS / SENSITIVE_SUFFIXES）做确定性匹配。
 *
 * 两条规则：
 * 1. 对象 / 数组深度遍历，命中敏感键的字段值整体替换为 '***'；
 * 2. 字符串按分隔符 tokenize，`k=v` / `k:v` 片段中 k 命中敏感键时替换为 `<k>=***`。
 *
 * 另提供 `redactArgs`（审计 args 落库用）：「字段名白名单 + 黑名单」双重过滤，
 * 非白名单键默认丢弃（.ai-spec 20-security.md SEC-1 MUST）。
 *
 * @module @agenthub/_shared/redact
 */
import { AUDIT_ALLOWED_FIELDS, SENSITIVE_FIELDS, SENSITIVE_SUFFIXES } from './constants.ts'

/** 敏感字段统一替换值。 */
export const REDACTED = '***'

/** 键名归一：小写、`-` 视同 `_`（X-Api-Key / clientSecret 类命名不因大小写或连字符漏判）。 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().split('-').join('_')
}

/** 字段名是否命中敏感清单（精确集或后缀规则；过杀方向安全）。 */
function isSensitiveField(name: string): boolean {
  const normalized = normalizeFieldName(name.trim())
  return SENSITIVE_FIELDS.has(normalized) || SENSITIVE_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

/** 字段名是否在白名单内（归一后精确匹配，大小写 / 连字符不敏感）。 */
function isAllowedField(name: string): boolean {
  return AUDIT_ALLOWED_FIELDS.has(normalizeFieldName(name.trim()))
}

/** 名字两端可能带 JSON / 引号包裹（{"token":"abc"}），剥壳后再比对。 */
function stripWrappers(name: string): string {
  const wrappers = new Set(['{', '}', '"', "'", '(', ')', ' ', '\t'])
  let start = 0
  let end = name.length
  while (start < end && wrappers.has(name.charAt(start))) start += 1
  while (end > start && wrappers.has(name.charAt(end - 1))) end -= 1
  return name.slice(start, end)
}

/** 文本片段（单个空白 / 标点分隔的 token）内 k=v / k:v 的脱敏。 */
function scrubToken(token: string): { out: string; colonRedacted: boolean } {
  const eq = token.indexOf('=')
  const colon = token.indexOf(':')
  const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon)
  if (sep <= 0) return { out: token, colonRedacted: false }
  const name = token.slice(0, sep)
  if (!isSensitiveField(stripWrappers(name))) return { out: token, colonRedacted: false }
  // 冒号空格形态（`token: abc`）的值是下一个 token，需一并吞掉；等号连写形态值已内联。
  return { out: `${name}=***`, colonRedacted: sep === colon }
}

/** 文本脱敏：`token=abc` / `password: abc` / JSON 片段 → `...=***`（k: v 的值 token 与其分隔符一并吞掉）。 */
export function redactText(text: string): string {
  const delimiters = new Set([' ', '\t', '\n', '\r', ',', ';', '&'])
  let pendingSwallow = false
  let pendingSep = ''
  let out = ''
  let token = ''
  const emit = (raw: string): void => {
    if (pendingSwallow) {
      pendingSwallow = false
      if (!raw.includes('=') && !raw.includes(':')) return
    }
    const scrubbed = scrubToken(raw)
    if (scrubbed.colonRedacted) pendingSwallow = true
    out += pendingSep + scrubbed.out
    pendingSep = ''
  }
  for (const ch of text) {
    if (delimiters.has(ch)) {
      emit(token)
      token = ''
      pendingSep += ch
    } else {
      token += ch
    }
  }
  emit(token)
  return out
}

/** 深度脱敏任意 JSON 兼容值；logger 落 sink 前必须先过本函数。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value instanceof Date) return value
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveField(key) ? REDACTED : redact(item)
    }
    return out
  }
  if (typeof value === 'string') return redactText(value)
  return value
}

/**
 * 审计 args 专用过滤（.ai-spec 20-security.md SEC-1 MUST：「黑名单 + 白名单」双重过滤，禁正则 §1.4）。
 *
 * 与 `redact`（黑名单兜底、尽量保留）语义不同，本函数**默认拒绝**：
 * - 命中黑名单（`AUDIT_DENIED_FIELDS` / 后缀规则）的键 → 整体置 `***`（优先判定，兜底）；
 * - 仅保留字段名白名单（`AUDIT_ALLOWED_FIELDS`）内的键，非白名单键一律丢弃；
 * - 对象 / 数组递归；字符串值再过 `redactText`（k=v 片段二次兜底）。
 *
 * 只做字段名 / 分隔片段确定性匹配，不使用正则。
 */
export function redactArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redactArgs(item))
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveField(key)) {
        out[key] = REDACTED
      } else if (isAllowedField(key)) {
        out[key] = redactArgs(item)
      }
    }
    return out
  }
  if (typeof value === 'string') return redactText(value)
  return value
}
