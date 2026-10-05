/**
 * 会话主人取自「打开项目对话」的登记；解析不出、多人等待或非成员一律不绑定。
 */
import { describe, expect, it } from 'vitest'
import { CHAT_INTENT_TTL_MS, ChatIntents, type ChatClaim } from '../src/chat-intent.ts'
import { resolveProjectChat } from '../src/session-bind.ts'

const PROJECT = 'a0eeeeee-0000-4000-8000-00000000000a'
const USER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const SESSION = 'session-1'

function deps(overrides: {
  workspaceId?: string | null
  projectId?: string | null
  claim?: ChatClaim
  member?: boolean
  throwWorkspace?: boolean
} = {}) {
  return {
    resolveWorkspaceId: () => {
      if (overrides.throwWorkspace === true) return Promise.reject(new Error('not a workspace'))
      return Promise.resolve(overrides.workspaceId === undefined ? 'ws-1' : overrides.workspaceId)
    },
    findProjectId: () => Promise.resolve(overrides.projectId === undefined ? PROJECT : overrides.projectId),
    claimOwner: (): ChatClaim => overrides.claim ?? { kind: 'owner', userId: USER },
    isMember: () => Promise.resolve(overrides.member !== false),
  }
}

describe('resolveProjectChat', () => {
  it('项目工作区 + 有打开登记 + 是成员 → 绑定到该员工', async () => {
    const result = await resolveProjectChat({ cwd: '/data/projects/a', sessionId: SESSION, ...deps() })
    expect(result).toEqual({ bound: true, target: { projectId: PROJECT, userId: USER, sessionId: SESSION } })
  })

  it('文件夹工作区解析不出项目 → 不绑定', async () => {
    const result = await resolveProjectChat({ cwd: '/tmp/folder', sessionId: SESSION, ...deps({ projectId: null }) })
    expect(result).toEqual({ bound: false, reason: 'no_project', projectId: null })
  })

  it('没有打开登记（例如恢复的旧会话）→ 不绑定', async () => {
    const result = await resolveProjectChat({ cwd: '/data/projects/a', sessionId: SESSION, ...deps({ claim: { kind: 'none' } }) })
    expect(result).toEqual({ bound: false, reason: 'no_owner', projectId: PROJECT })
  })

  it('多名员工同时在等待 → 不绑定', async () => {
    const result = await resolveProjectChat({ cwd: '/data/projects/a', sessionId: SESSION, ...deps({ claim: { kind: 'ambiguous' } }) })
    expect(result).toEqual({ bound: false, reason: 'ambiguous_owner', projectId: PROJECT })
  })

  it('不是该项目成员 → 不绑定', async () => {
    const result = await resolveProjectChat({ cwd: '/data/projects/a', sessionId: SESSION, ...deps({ member: false }) })
    expect(result).toEqual({ bound: false, reason: 'not_member', projectId: PROJECT })
  })

  it('工作目录为空或解析失败 → 不绑定', async () => {
    expect(await resolveProjectChat({ cwd: '  ', sessionId: SESSION, ...deps() }))
      .toEqual({ bound: false, reason: 'no_workspace', projectId: null })
    expect(await resolveProjectChat({ cwd: '/missing', sessionId: SESSION, ...deps({ throwWorkspace: true }) }))
      .toEqual({ bound: false, reason: 'no_workspace', projectId: null })
  })
})

describe('ChatIntents', () => {
  it('一次登记只认领一次', () => {
    const intents = new ChatIntents(() => 0)
    intents.expect(PROJECT, USER)
    expect(intents.claim(PROJECT)).toEqual({ kind: 'owner', userId: USER })
    expect(intents.claim(PROJECT)).toEqual({ kind: 'none' })
  })

  it('同一员工的多次登记依次认领', () => {
    const intents = new ChatIntents(() => 0)
    intents.expect(PROJECT, USER)
    intents.expect(PROJECT, USER)
    expect(intents.claim(PROJECT)).toEqual({ kind: 'owner', userId: USER })
    expect(intents.claim(PROJECT)).toEqual({ kind: 'owner', userId: USER })
    expect(intents.claim(PROJECT)).toEqual({ kind: 'none' })
  })

  it('不同员工同时等待 → ambiguous，且不消耗登记', () => {
    const clock = { now: 0 }
    const intents = new ChatIntents(() => clock.now)
    intents.expect(PROJECT, USER)
    intents.expect(PROJECT, OTHER)
    expect(intents.claim(PROJECT)).toEqual({ kind: 'ambiguous' })
    expect(intents.claim(PROJECT)).toEqual({ kind: 'ambiguous' })
    clock.now = CHAT_INTENT_TTL_MS
    expect(intents.claim(PROJECT)).toEqual({ kind: 'none' })
  })

  it('过期登记不认领；登记按项目隔离', () => {
    const clock = { now: 0 }
    const intents = new ChatIntents(() => clock.now)
    intents.expect(PROJECT, USER)
    expect(intents.claim('other-project')).toEqual({ kind: 'none' })
    clock.now = CHAT_INTENT_TTL_MS
    expect(intents.claim(PROJECT)).toEqual({ kind: 'none' })
  })
})
