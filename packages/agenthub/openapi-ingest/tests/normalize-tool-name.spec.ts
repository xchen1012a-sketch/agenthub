/**
 * 工具名规范化（P5 修复：导入适配底座命名）。
 *
 * 工具名每次请求都要作为 `tools[].function.name` 发给模型服务，而函数调用协议
 * 只接受 `^[A-Za-z0-9_-]{1,128}$`。不同业务系统的 `operationId` 写法各异
 * （`user.get` / `user/get` / `订单查询`），因此**导入时适配**，而不是要求对方改写：
 * 非法字符转 `_`，首尾与重复分隔符合并，超长截断。
 *
 * 测试直接打在解析器上（`toDraft` 经 `parseOpenApiDocument` 驱动），断言的是**进库的名字**
 * 与**被跳过的原因**，不测内部实现。
 *
 * @module tests/normalize-tool-name.spec
 */
import { describe, expect, it } from 'vitest'
import { normalizeToolName, parseOpenApiDocument, SKIP_REASONS } from '../src/index.ts'

/**
 * 造一份单 operation 的 OpenAPI 文档。
 * @param operationId - 该 operation 的 operationId。
 * @returns OpenAPI 文档对象。
 */
function docWith(operationId: string) {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/x': {
        get: { operationId, responses: { 200: { description: 'ok' } } },
      },
    },
  }
}

describe('normalizeToolName', () => {
  it('合法名原样保留（不产生多余改动）', () => {
    expect(normalizeToolName('echo_read')).toBe('echo_read')
    expect(normalizeToolName('queryCustomer')).toBe('queryCustomer')
    expect(normalizeToolName('user-get-2')).toBe('user-get-2')
  })

  it('点号 / 斜杠 / 空格等非法字符转下划线', () => {
    expect(normalizeToolName('echo.read')).toBe('echo_read')
    expect(normalizeToolName('user/get')).toBe('user_get')
    expect(normalizeToolName('user get')).toBe('user_get')
    expect(normalizeToolName('a:b;c')).toBe('a_b_c')
  })

  it('连续非法字符合并为一个下划线，并去掉首尾下划线', () => {
    expect(normalizeToolName('a..b')).toBe('a_b')
    expect(normalizeToolName('.leading')).toBe('leading')
    expect(normalizeToolName('trailing.')).toBe('trailing')
    expect(normalizeToolName('a...b')).toBe('a_b')
  })

  it('纯非 ASCII 名无可用字符 → undefined（调用方跳过并记原因）', () => {
    expect(normalizeToolName('订单查询')).toBeUndefined()
    expect(normalizeToolName('。。。')).toBeUndefined()
    expect(normalizeToolName('')).toBeUndefined()
  })

  it('中英混写：保留 ASCII 部分，中文折为下划线', () => {
    expect(normalizeToolName('订单get')).toBe('get')
    expect(normalizeToolName('get订单List')).toBe('get_List')
  })

  it('超长名截断到 128 且不留尾随下划线', () => {
    const long = 'a'.repeat(200)
    const normalized = normalizeToolName(long)
    expect(normalized).toHaveLength(128)

    // 第 128 位恰好是分隔符时必须一并去掉，否则名字以 `_` 收尾。
    const boundary = `${'a'.repeat(127)}.${'b'.repeat(10)}`
    const cut = normalizeToolName(boundary)
    expect(cut).toBe('a'.repeat(127))
    expect(cut?.endsWith('_')).toBe(false)
  })

  it('首字符是数字仍然合法（协议不禁止数字开头）', () => {
    expect(normalizeToolName('2fa.verify')).toBe('2fa_verify')
  })
})

describe('导入时规范化（parseOpenApiDocument）', () => {
  it('非法 operationId 被规范化后进库，而不是被跳过', () => {
    const { drafts, skipped } = parseOpenApiDocument(docWith('user.get'))

    expect(skipped).toHaveLength(0)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.name).toBe('user_get')
  })

  it('改名后保留原始 operationId 以便追溯（写进描述）', () => {
    const { drafts } = parseOpenApiDocument(docWith('user.get'))

    expect(drafts[0]?.description).toContain('user.get')
  })

  it('名字未变时不追加原始名（描述保持干净）', () => {
    const { drafts } = parseOpenApiDocument(docWith('userGet'))

    expect(drafts[0]?.description).not.toContain('原名')
  })

  it('无可用 ASCII 字符 → 跳过并给出明确原因', () => {
    const { drafts, skipped } = parseOpenApiDocument(docWith('订单查询'))

    expect(drafts).toHaveLength(0)
    expect(skipped[0]?.reason).toBe(SKIP_REASONS.unnameableOperationId)
  })

  it('规范化后的名字全部满足协议字符集（回归防线）', () => {
    const { drafts } = parseOpenApiDocument(docWith('订单.get/客户?id=1'))

    for (const draft of drafts) {
      expect(draft.name).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    }
  })
})
