import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { QueryResult, QueryResultRow } from 'pg'
import { AgenthubError, asUserId, type Logger } from '@agenthub/_shared'
import {
  CSRF_COOKIE,
  DEV_USER_ID,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  AuthService,
  createCsrfToken,
  csrfSetCookie,
  devAnonEnabled,
  hashPassword,
  parseCookies,
  sessionSetCookie,
  verifyCsrf,
  verifiedSessionId,
} from '../src/index.ts'

const SECRET = 'unit-test-cookie-secret-0123456789abcdef'

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, url: '/agenthub/projects', method: 'GET' } as unknown as IncomingMessage
}

interface FakeDb {
  calls: { text: string; values: readonly unknown[] }[]
  db: {
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<Pick<QueryResult<R>, 'rows'>>
  }
}

function fakeDb(responses: { rows: unknown[] }[] = []): FakeDb {
  const calls: { text: string; values: readonly unknown[] }[] = []
  return {
    calls,
    db: {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<Pick<QueryResult<R>, 'rows'>> {
        calls.push({ text, values: values ?? [] })
        return { rows: (responses.shift()?.rows ?? []) as R[] }
      },
    },
  }
}

const silentLogger: Logger = {
  package: 'agenthub/auth-test',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('dev 匿名（.ai-spec 20-security.md SEC-4 的开发后门）', () => {
  it('dev 开关默认开启，解析出固定匿名身份；首次解析幂等 upsert 用户行', async () => {
    const fake = fakeDb()
    const auth = new AuthService({ db: fake.db })
    expect(auth.devAnon).toBe(true)
    const user = await auth.resolveIdentity(fakeReq())
    expect(user.userId).toBe(DEV_USER_ID)
    expect(user.roles).toContain('platform_admin')
    expect(user.sessionId).toBeNull()
    expect(fake.calls[0]?.text).toContain('INSERT INTO users')
    // 第二次解析复用进程内守卫，不再触库。
    await auth.resolveIdentity(fakeReq())
    expect(fake.calls).toHaveLength(1)
  })

  it('devAnonEnabled 只认显式 false（未设置 / 其他值均开启）', () => {
    expect(devAnonEnabled({})).toBe(true)
    expect(devAnonEnabled({ AGENTHUB_AUTH_DEV_ANON: 'true' })).toBe(true)
    expect(devAnonEnabled({ AGENTHUB_AUTH_DEV_ANON: 'false' })).toBe(false)
  })

  it('dev 模式不签发会话 Cookie（无密钥，503 fail-closed）', () => {
    const auth = new AuthService({ db: fakeDb().db })
    try {
      auth.sessionCookie('00000000-0000-4000-8000-00000000000a')
      expect.unreachable('必须抛错')
    } catch (error) {
      expect((error as AgenthubError).code).toBe('agenthub/auth/CookieSecretMissing')
      expect((error as AgenthubError).httpStatus).toBe(503)
    }
  })
})

describe('密钥校验（.ai-spec 20-security.md SEC-7）', () => {
  it('真登录模式缺 AGENTHUB_COOKIE_SECRET → 构造期启动失败', () => {
    expect(() => new AuthService({ db: fakeDb().db, env: { AGENTHUB_AUTH_DEV_ANON: 'false' } })).toThrow(
      /AGENTHUB_COOKIE_SECRET/,
    )
  })

  it('真登录模式密钥不足 32 字符 → 构造期启动失败', () => {
    expect(
      () =>
        new AuthService({
          db: fakeDb().db,
          env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: 'short' },
        }),
    ).toThrow(/32/)
  })

  it('dev 开启且配置了密钥 → 密钥可用（Cookie 签发不抛）', () => {
    const auth = new AuthService({
      db: fakeDb().db,
      env: { AGENTHUB_COOKIE_SECRET: SECRET },
    })
    expect(auth.sessionCookie('00000000-0000-4000-8000-00000000000a')).toContain(`${SESSION_COOKIE}=`)
  })
})

describe('注册 / 登录（Argon2id + sessions 表）', () => {
  it('signUp：Argon2id 摘要入库 + 默认 member 角色；摘要不是明文', async () => {
    const fake = fakeDb([{ rows: [{ id: 'u-1' }] }])
    const auth = new AuthService({ db: fake.db, logger: silentLogger })
    const user = await auth.signUp({ email: 'A@Example.com', displayName: '阿珍', password: 'p@ssw0rd-123' })
    expect(user.userId).toBe(asUserId('u-1'))
    expect(user.roles).toEqual(['member'])
    expect(fake.calls[0]?.text).toContain('INSERT INTO users')
    expect(fake.calls[0]?.values[0]).toBe('a@example.com')
    const hash = String(fake.calls[0]?.values[2])
    expect(hash.startsWith('$argon2')).toBe(true)
    expect(hash).not.toContain('p@ssw0rd')
    expect(fake.calls[1]?.text).toContain('FROM roles WHERE name = $2')
    expect(fake.calls[1]?.values[1]).toBe('member')
  })

  it('signUp：非法入参 400；email 冲突 409（不泄露堆栈）', async () => {
    const auth = new AuthService({ db: fakeDb().db, logger: silentLogger })
    const invalid = await auth.signUp({ email: '', displayName: '', password: '123' }).catch((e: unknown) => e)
    expect((invalid as AgenthubError).code).toBe('agenthub/auth/InvalidSignUp')
    expect((invalid as AgenthubError).httpStatus).toBe(400)

    const conflictDb = fakeDb()
    conflictDb.db.query = async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' })
    }
    const conflicted = new AuthService({ db: conflictDb.db, logger: silentLogger })
    const conflict = await conflicted
      .signUp({ email: 'a@b.com', displayName: 'A', password: 'p@ssw0rd-123' })
      .catch((e: unknown) => e)
    expect((conflict as AgenthubError).code).toBe('agenthub/auth/EmailExists')
    expect((conflict as AgenthubError).httpStatus).toBe(409)
  })

  it('signIn：校验通过 → sessions 行（TTL 24h）+ 角色 + 日志', async () => {
    const hash = await hashPassword('correct-horse')
    const logs: { event: string; userId: string | null; sessionId: string | null }[] = []
    const fake = fakeDb([
      { rows: [{ id: 'u-1', display_name: '阿珍', password_hash: hash, status: 'active' }] },
      { rows: [{ id: 's-1' }] },
      { rows: [{ name: 'member' }] },
    ])
    const auth = new AuthService({
      db: fake.db,
      logger: {
        ...silentLogger,
        info: (record) => {
          logs.push({ event: record.event, userId: record.userId, sessionId: record.sessionId })
        },
      },
    })
    const result = await auth.signIn({ email: 'a@example.com', password: 'correct-horse' }, 'tid-1')
    expect(result.sessionId).toBe('s-1')
    expect(result.user.roles).toEqual(['member'])
    expect(fake.calls[1]?.text).toContain('INSERT INTO sessions')
    const expiresAt = fake.calls[1]?.values[1] as Date
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5000)
    expect(logs).toEqual([{ event: 'user.authenticated', userId: 'u-1', sessionId: 's-1' }])
  })

  it('signIn：密码错误与账号不存在统一 401（不泄露存在性）', async () => {
    const hash = await hashPassword('correct-horse')
    const make = (rows: unknown[]) =>
      new AuthService({ db: fakeDb([{ rows }]).db, logger: silentLogger })
    const wrong = await make([
      { id: 'u-1', display_name: 'A', password_hash: hash, status: 'active' },
    ]).signIn({ email: 'a@example.com', password: 'wrong' }, null).catch((e: unknown) => e)
    expect((wrong as AgenthubError).code).toBe('agenthub/auth/InvalidCredential')
    expect((wrong as AgenthubError).httpStatus).toBe(401)

    const missing = await make([]).signIn({ email: 'ghost@example.com', password: 'x' }, null).catch((e: unknown) => e)
    expect((missing as AgenthubError).code).toBe('agenthub/auth/InvalidCredential')
  })

  it('signIn：disabled 账号 fail-closed 401', async () => {
    const hash = await hashPassword('correct-horse')
    const auth = new AuthService({
      db: fakeDb([{ rows: [{ id: 'u-1', display_name: 'A', password_hash: hash, status: 'disabled' }] }]).db,
      logger: silentLogger,
    })
    const error = await auth.signIn({ email: 'a@example.com', password: 'correct-horse' }, null).catch((e: unknown) => e)
    expect((error as AgenthubError).code).toBe('agenthub/auth/InvalidCredential')
  })
})

describe('会话解析（Cookie + 滑动续期）', () => {
  const SID = '00000000-0000-4000-8000-00000000abc1'

  function reqWithSession(secret: string, sessionId: string): IncomingMessage {
    const cookie = sessionSetCookie(secret, sessionId).split(';')[0] ?? ''
    return fakeReq({ cookie })
  }

  it('有效会话 → 身份 + 角色库 + 滑动续期 UPDATE', async () => {
    const fake = fakeDb([
      { rows: [{ user_id: 'u-1', display_name: '阿珍', status: 'active', expires_at: new Date(Date.now() + 1000) }] },
      { rows: [{ name: 'platform_admin' }] },
    ])
    const auth = new AuthService({
      db: fake.db,
      env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: SECRET },
      logger: silentLogger,
    })
    const identity = await auth.resolveIdentity(reqWithSession(SECRET, SID))
    expect(identity.userId).toBe(asUserId('u-1'))
    expect(identity.sessionId).toBe(SID)
    expect(fake.calls.some(call => call.text.includes('UPDATE sessions SET expires_at'))).toBe(true)
  })

  it('过期会话 → 401 且删除行（懒过期）', async () => {
    const fake = fakeDb([
      { rows: [{ user_id: 'u-1', display_name: 'A', status: 'active', expires_at: new Date(Date.now() - 1000) }] },
    ])
    const auth = new AuthService({
      db: fake.db,
      env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: SECRET },
      logger: silentLogger,
    })
    const error = await auth.resolveIdentity(reqWithSession(SECRET, SID)).catch((e: unknown) => e)
    expect((error as AgenthubError).code).toBe('agenthub/auth/Unauthenticated')
    expect((error as AgenthubError).httpStatus).toBe(401)
    expect(fake.calls.some(call => call.text.includes('DELETE FROM sessions'))).toBe(true)
  })

  it('disabled 账号 → 403 AccountDisabled', async () => {
    const auth = new AuthService({
      db: fakeDb([
        { rows: [{ user_id: 'u-1', display_name: 'A', status: 'disabled', expires_at: new Date(Date.now() + 1000) }] },
      ]).db,
      env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: SECRET },
      logger: silentLogger,
    })
    const error = await auth.resolveIdentity(reqWithSession(SECRET, SID)).catch((e: unknown) => e)
    expect((error as AgenthubError).code).toBe('agenthub/auth/AccountDisabled')
    expect((error as AgenthubError).httpStatus).toBe(403)
  })

  it('无 Cookie / 篡改签名 → 401，不触库', async () => {
    const fake = fakeDb()
    const auth = new AuthService({
      db: fake.db,
      env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: SECRET },
      logger: silentLogger,
    })
    const noCookie = await auth.resolveIdentity(fakeReq()).catch((e: unknown) => e)
    expect((noCookie as AgenthubError).httpStatus).toBe(401)
    const tampered = await auth
      .resolveIdentity(fakeReq({ cookie: `${SESSION_COOKIE}=${SID}.bad-signature` }))
      .catch((e: unknown) => e)
    expect((tampered as AgenthubError).httpStatus).toBe(401)
    expect(fake.calls).toHaveLength(0)
  })

  it('signOut：删除会话行；无有效 Cookie 时静默', async () => {
    const fake = fakeDb()
    const auth = new AuthService({
      db: fake.db,
      env: { AGENTHUB_AUTH_DEV_ANON: 'false', AGENTHUB_COOKIE_SECRET: SECRET },
      logger: silentLogger,
    })
    await auth.signOut(reqWithSession(SECRET, SID))
    expect(fake.calls[0]?.text).toContain('DELETE FROM sessions')
    fake.calls.length = 0
    await auth.signOut(fakeReq())
    expect(fake.calls).toHaveLength(0)
  })

  it('登录态 Cookie 携带安全标志（HttpOnly / SameSite=Lax / 24h）', () => {
    const cookie = sessionSetCookie(SECRET, SID)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`)
  })
})

describe('Cookie / CSRF 工具（.ai-spec 20-security.md SEC-4）', () => {
  it('parseCookies：解析、解码、忽略无值片段', () => {
    const jar = parseCookies('a=1; b=%E4%B8%AD; broken; =empty')
    expect(jar).toEqual({ a: '1', b: '中' })
    expect(parseCookies(undefined)).toEqual({})
  })

  it('verifiedSessionId：签名校验 roundtrip + 防篡改 + 缺失', () => {
    const sid = '00000000-0000-4000-8000-00000000abc2'
    const jar = parseCookies(sessionSetCookie(SECRET, sid))
    expect(verifiedSessionId(SECRET, jar)).toBe(sid)
    expect(verifiedSessionId(SECRET, { [SESSION_COOKIE]: `${sid}.forgored` })).toBeNull()
    expect(verifiedSessionId(SECRET, { [SESSION_COOKIE]: 'no-dot' })).toBeNull()
    expect(verifiedSessionId(SECRET, {})).toBeNull()
  })

  it('CSRF 双提交：Cookie 与提交令牌一致才放行', () => {
    const token = createCsrfToken()
    expect(csrfSetCookie(token)).toContain(`${CSRF_COOKIE}=${token}`)
    expect(verifyCsrf({ [CSRF_COOKIE]: token }, token)).toBe(true)
    expect(verifyCsrf({ [CSRF_COOKIE]: token }, 'other')).toBe(false)
    expect(verifyCsrf({}, token)).toBe(false)
    expect(verifyCsrf({ [CSRF_COOKIE]: token }, null)).toBe(false)
    expect(verifyCsrf({ [CSRF_COOKIE]: token }, '')).toBe(false)
  })
})
