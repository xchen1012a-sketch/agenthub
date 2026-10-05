import { describe, expect, it, vi } from 'vitest'
import {
  buildDbmateArgs,
  loadDeployEnv,
  resolveDbmateBin,
  resolveDbUrl,
  runDbmate,
  type Spawn,
} from '../run-dbmate.mjs'

describe('dbmate runner 环境解析', () => {
  it('deploy/.env 只回填缺失变量，不覆盖进程已有值', () => {
    const env: Record<string, string | undefined> = { AGENTHUB_DB_URL: 'postgres://existing/db' }
    loadDeployEnv(env, 'AGENTHUB_DB_URL=postgres://file/db\nAGENTHUB_DB_PASSWORD="from-file"\n')
    expect(env).toEqual({
      AGENTHUB_DB_URL: 'postgres://existing/db',
      AGENTHUB_DB_PASSWORD: 'from-file',
    })
  })

  it('缺少连接串时抛出带配置指引的错误', () => {
    expect(() => resolveDbUrl({})).toThrow(/AGENTHUB_DB_URL 未设置/)
    expect(() => resolveDbUrl({})).toThrow(/deploy\/.env/)
  })

  it('仅为本地数据库补 sslmode=disable，远程地址与显式配置保持不变', () => {
    expect(resolveDbUrl({ AGENTHUB_DB_URL: 'postgres://u:p@localhost:5432/db' }))
      .toBe('postgres://u:p@localhost:5432/db?sslmode=disable')
    expect(resolveDbUrl({ AGENTHUB_DB_URL: 'postgres://u:p@127.0.0.1:5432/db?connect_timeout=5' }))
      .toBe('postgres://u:p@127.0.0.1:5432/db?connect_timeout=5&sslmode=disable')
    expect(resolveDbUrl({ AGENTHUB_DB_URL: 'postgres://u:p@db.example.com:5432/db' }))
      .toBe('postgres://u:p@db.example.com:5432/db')
    expect(resolveDbUrl({ AGENTHUB_DB_URL: 'postgres://u:p@localhost:5432/db?sslmode=require' }))
      .toBe('postgres://u:p@localhost:5432/db?sslmode=require')
  })
})

describe('dbmate runner 二进制与参数', () => {
  it('二进制定位按显式配置、PATH、包内 node_modules 三级回退', () => {
    const spawn = vi.fn<Spawn>(() => ({ status: 0 }))
    expect(resolveDbmateBin({ AGENTHUB_DBMATE_BIN: 'C:/tools/dbmate.exe' }, 'win32', spawn, () => false, 'C:/pkg'))
      .toBe('C:/tools/dbmate.exe')
    expect(resolveDbmateBin({}, 'linux', spawn, () => false, '/pkg')).toBe('dbmate')

    const missingOnPath = vi.fn<Spawn>(() => ({ status: 1 }))
    expect(resolveDbmateBin({}, 'win32', missingOnPath, file => file.endsWith('dbmate.cmd'), 'C:/pkg'))
      .toBe('C:\\pkg\\node_modules\\.bin\\dbmate.cmd')
  })

  it('固定迁移目录和 schema dump 参数，并原样透传子命令', () => {
    expect(buildDbmateArgs(['status', '--verbose'])).toEqual([
      '--migrations-dir', 'sql',
      '--no-dump-schema',
      'status', '--verbose',
    ])
  })

  it('通过 DATABASE_URL 环境变量传递连接串，不放入命令行参数', () => {
    const spawn = vi.fn<Spawn>(() => ({ status: 0 }))
    const status = runDbmate({
      argv: ['status'],
      env: { AGENTHUB_DB_URL: 'postgres://u:p@localhost:5432/db', AGENTHUB_DBMATE_BIN: 'dbmate' },
      platform: 'linux',
      pkgDir: '/pkg',
      deployEnvContent: '',
      spawn,
      exists: () => false,
    })

    expect(status).toBe(0)
    expect(spawn).toHaveBeenCalledOnce()
    const [bin, args, options] = spawn.mock.calls[0] ?? []
    expect(bin).toBe('dbmate')
    expect(args).not.toContain('--url')
    expect(options?.env?.DATABASE_URL).toBe('postgres://u:p@localhost:5432/db?sslmode=disable')
  })
})
