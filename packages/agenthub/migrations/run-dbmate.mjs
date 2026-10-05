#!/usr/bin/env node
/**
 * @agenthub/migrations · dbmate 跨平台 runner。
 *
 * 连接串只通过 DATABASE_URL 子进程环境变量传入，避免出现在进程参数中。
 * 规范：deepseek-harness/.ai-spec/.ai-spec 30-data.md DATA-3。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.dirname(fileURLToPath(import.meta.url))
const agenthubRoot = path.resolve(pkgDir, '../../../..')

/** Runner 可预期配置错误。 */
export class DbmateRunnerError extends Error {}

/** 从 deploy/.env 文本回填缺失的环境变量，不覆盖进程已有值。 */
export function loadDeployEnv(env, content) {
  if (content === undefined) return
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (env[key] === undefined) env[key] = value
  }
}

/** 解析 dbmate 连接串；仅本地地址在未显式配置时关闭 SSL。 */
export function resolveDbUrl(env) {
  const raw = env.AGENTHUB_DB_URL
  if (raw === undefined || raw === '') {
    throw new DbmateRunnerError([
      '[agenthub/migrations] AGENTHUB_DB_URL 未设置。',
      '  方式一：设置环境变量 AGENTHUB_DB_URL=postgres://agenthub:<password>@localhost:5432/agenthub',
      '  方式二：复制 deploy/.env.example 为 deploy/.env 并填写（runner 会自动加载）',
    ].join('\n'))
  }

  const parsed = new URL(raw)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (!local || parsed.searchParams.has('sslmode')) return raw
  parsed.searchParams.set('sslmode', 'disable')
  return parsed.toString()
}

/** 依次尝试显式配置、PATH、包内 node_modules/.bin。 */
export function resolveDbmateBin(env, platform, spawn, exists, packageDir) {
  if (env.AGENTHUB_DBMATE_BIN !== undefined && env.AGENTHUB_DBMATE_BIN !== '') {
    return env.AGENTHUB_DBMATE_BIN
  }
  const windows = platform === 'win32'
  const executable = windows ? 'dbmate.cmd' : 'dbmate'
  const probe = spawn(executable, ['--version'], { stdio: 'ignore', shell: windows })
  if (probe.status === 0) return executable
  const join = windows ? path.win32.join : path.posix.join
  const localBin = join(packageDir, 'node_modules', '.bin', executable)
  if (exists(localBin)) return localBin
  throw new DbmateRunnerError([
    '[agenthub/migrations] 未找到 dbmate 可执行文件。',
    '  安装方式：在 packages/agenthub/migrations 下 pnpm add -D dbmate，',
    '  或全局安装后设置 AGENTHUB_DBMATE_BIN 指向它。',
  ].join('\n'))
}

/** 构造固定参数并透传 dbmate 子命令。 */
export function buildDbmateArgs(dbmateArgs) {
  if (dbmateArgs.length === 0) {
    throw new DbmateRunnerError(
      '[agenthub/migrations] 用法：node run-dbmate.mjs <up|status|rollback|drop|dump> [dbmate 其余参数]',
    )
  }
  return ['--migrations-dir', 'sql', '--no-dump-schema', ...dbmateArgs]
}

/** 执行一次 dbmate；返回子进程退出码。 */
export function runDbmate({
  argv,
  env,
  platform,
  pkgDir: packageDir,
  deployEnvContent,
  spawn,
  exists,
}) {
  loadDeployEnv(env, deployEnvContent)
  const databaseUrl = resolveDbUrl(env)
  const executable = resolveDbmateBin(env, platform, spawn, exists, packageDir)
  const result = spawn(executable, buildDbmateArgs(argv), {
    cwd: packageDir,
    stdio: 'inherit',
    shell: platform === 'win32',
    env: { ...env, DATABASE_URL: databaseUrl },
  })
  return result.status ?? 1
}

function main() {
  const envFile = path.join(agenthubRoot, 'deploy', '.env')
  const deployEnvContent = existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined
  try {
    return runDbmate({
      argv: process.argv.slice(2),
      env: process.env,
      platform: process.platform,
      pkgDir,
      deployEnvContent,
      spawn: spawnSync,
      exists: existsSync,
    })
  } catch (error) {
    if (error instanceof DbmateRunnerError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main())
}
