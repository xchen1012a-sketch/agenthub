import { describe, expect, it } from 'vitest'
import { MESSAGES, pickLocale, t } from '../src/index.ts'

describe('i18n（U4：en / zh 双语同步）', () => {
  it('en 与 zh 键集合完全一致', () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.zh).sort())
  })

  it('每个键的两种语言文案非空', () => {
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      expect(MESSAGES.en[key].length, `en.${key}`).toBeGreaterThan(0)
      expect(MESSAGES.zh[key].length, `zh.${key}`).toBeGreaterThan(0)
    }
  })

  it('t 取对应语言文案', () => {
    expect(t('zh', 'login.signIn')).toBe('登录')
    expect(t('en', 'login.signIn')).toBe('Sign in')
    expect(t('zh', 'sessions.title')).toBe('会话列表')
    expect(t('en', 'nav.logout')).toBe('Sign out')
  })
})

describe('pickLocale（Accept-Language 协商，RFC 7231 §5.3.4 q-weight）', () => {
  it('中文优先：zh / zh-CN;q=0.9,en;q=0.8 → zh', () => {
    expect(pickLocale(undefined)).toBe('zh')
    expect(pickLocale('')).toBe('zh')
    expect(pickLocale('zh-CN,zh;q=0.9')).toBe('zh')
    expect(pickLocale('zh-CN;q=0.9,en;q=0.8')).toBe('zh')
  })

  it('纯英文请求 → en', () => {
    expect(pickLocale('en-US,en;q=0.9')).toBe('en')
    expect(pickLocale('ja-JP,en;q=0.7')).toBe('en')
  })

  it('q-weight 反转：zh;q=0.1,en;q=0.9 → en（高权重胜出，不是按出现顺序）', () => {
    expect(pickLocale('zh-CN;q=0.1,en;q=0.9')).toBe('en')
    expect(pickLocale('zh;q=0.2,en;q=0.8')).toBe('en')
  })

  it('缺 q 值默认 1.0：zh → zh、en → en', () => {
    expect(pickLocale('zh')).toBe('zh')
    expect(pickLocale('en')).toBe('en')
  })

  it('完全无法识别的 tag → zh（兜底）', () => {
    expect(pickLocale('ja-JP,fr-FR;q=0.7')).toBe('zh')
  })
})
