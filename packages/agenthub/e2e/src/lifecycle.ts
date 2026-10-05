/**
 * AgentHub 端到端脚手架：真进程 + 真库 + 真浏览器（P5 阶段书 §7.1-3）。
 *
 * 与上游 `apps/web/tests/scaffold.ts` 的区别：那个脚手架在临时目录里用符号链接
 * 组装一个**空白 profile**，用于验证上游 Web 组合本身；本文件要验证的是
 * **AgentHub profile 的真实行为**（鉴权、Project 归属、Tool 执行、审计、指标），
 * 因此直接启动 `apps/cli` 的 agenthub profile，指向**独立数据库**。
 *
 * 隔离是硬要求：E2E 会写 Project / Tool / 审计行，绝不能落在开发或验收用的库上。
 * 目标库由 `AGENTHUB_E2E_DB_URL` 指定；未设置时**拒绝启动**而不是回落到默认库。
 *
 * @module @agenthub/e2e/lifecycle
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 同步播种需要同步子进程调用，而本模块是 ESM（无 `require`）。 */
const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（deepseek-harness/）：src → e2e → agenthub → packages → 根。 */
export const HARNESS_ROOT = resolve(HERE, '../../../..')

/** E2E 服务端口：与开发用的 5080 错开，避免测试打到手工起的实例。 */
export const E2E_PORT = 5081

/**
 * 解析 Playwright 使用的浏览器可执行文件。
 *
 * 优先 `DSH_PLAYWRIGHT_EXECUTABLE_PATH`（与上游 e2e 同一约定），否则探测系统已装的
 * Chrome / Edge。返回 `undefined` 表示交给 Playwright 自带的下载产物——CI 用那条路，
 * 本地缺下载时不必等安装。
 * @returns 可执行文件路径；无可选项时为 `undefined`。
 */
export function resolveBrowserExecutable(): string | undefined {
  const explicit = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()

  const candidates = [
    `${process.env['PROGRAMFILES'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['PROGRAMFILES'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ]
  return candidates.find(candidate => existsSync(candidate))
}

/** dev 匿名身份（`AuthService` 在 `AGENTHUB_AUTH_DEV_ANON !== 'false'` 时 upsert 为平台管理员）。 */
export const E2E_USER_ID = '00000000-0000-4000-8000-000000000001'

/** 正在运行的应用进程与基址。 */
export interface E2eApp {
  readonly baseUrl: string
  readonly proc: ChildProcess
  /** 终止进程（幂等）。 */
  stop(): void
}

/**
 * 读取目标库连接串。
 *
 * 优先 `AGENTHUB_E2E_DB_URL`（想隔离时用），否则回落 `AGENTHUB_DB_URL`，
 * 再否则交给 `deploy/.env` 回填。E2E 会写 Project / 审计等行，跑完由
 * `deploy/scripts/reset-db.sh` 清空。
 * @returns 连接串；三处都未配置时为 `undefined`（由启动期校验报错）。
 */
export function e2eDatabaseUrl(): string | undefined {
  const explicit = process.env.AGENTHUB_E2E_DB_URL ?? process.env.AGENTHUB_DB_URL
  return explicit === undefined || explicit.trim() === '' ? undefined : explicit.trim()
}

/**
 * 解析 E2E 目标库连接串（含 `deploy/.env` 回填）。
 *
 * 与 {@link startApp} 用同一套优先级，供测试的播种/清理直接连库使用。
 * @returns 连接串。
 * @throws Error 三处都未配置时。
 */
export function resolveDatabaseUrl(): string {
  const direct = e2eDatabaseUrl()
  if (direct !== undefined) return direct

  const envFile = join(HARNESS_ROOT, '..', 'deploy', '.env')
  if (existsSync(envFile)) {
    for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.startsWith('AGENTHUB_DB_URL=')) return line.slice('AGENTHUB_DB_URL='.length).trim()
    }
  }
  throw new Error('未找到 AGENTHUB_DB_URL（环境变量与 deploy/.env 均无）。')
}

/**
 * 启动 agenthub profile。
 *
 * 密钥类变量从 `deploy/.env` 回填（不覆盖进程已有值）。健康检查通过后才返回，
 * 避免测试与启动竞态。
 * @param options.timeoutMs - 等待 `/healthz` 的上限（默认 90s）。
 * @param options.port - 监听端口（默认 {@link E2E_PORT}）。
 * @returns 运行中的应用。
 */
export async function startApp(options: { timeoutMs?: number; port?: number } = {}): Promise<E2eApp> {
  const timeoutMs = options.timeoutMs ?? 90_000
  const port = options.port ?? E2E_PORT
  const envFile = join(HARNESS_ROOT, '..', 'deploy', '.env')
  const env: NodeJS.ProcessEnv = { ...process.env }

  // 回填缺失变量（含 LLM/Embedding 端点与密钥）；不覆盖显式传入的值。
  if (existsSync(envFile)) {
    for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      if (env[key] === undefined) env[key] = line.slice(eq + 1).trim()
    }
  }
  const dbUrl = e2eDatabaseUrl()
  if (dbUrl !== undefined) env.AGENTHUB_DB_URL = dbUrl

  const proc = spawn(
    process.execPath,
    [
      '--import', 'tsx/esm',
      'apps/cli/src/bin.ts',
      '--profile', 'agenthub',
      '--patch', 'apps/web/config/agenthub.yaml',
      '--port', String(port),
      '--no-open',
    ],
    { cwd: HARNESS_ROOT, env, stdio: 'inherit' },
  )

  const baseUrl = `http://127.0.0.1:${String(port)}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`agenthub profile 提前退出（code=${String(proc.exitCode)}），无法进行 E2E。`)
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`)
      if (res.ok) break
    } catch {
      // 未就绪：继续等。
    }
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error(`等待 ${baseUrl}/healthz 超时（${String(timeoutMs)}ms）。`)
    }
    await new Promise(r => setTimeout(r, 250))
  }

  let stopped = false
  return {
    baseUrl,
    proc,
    stop() {
      if (stopped) return
      stopped = true
      proc.kill()
    },
  }
}

/**
 * 以 dev 匿名身份请求 AgentHub 的 JSON API。
 *
 * dev 匿名下每条请求都解析为同一平台管理员，因此 E2E 无需维护会话与 CSRF。
 * @param app - 运行中的应用。
 * @param path - `/agenthub/api/...` 路径。
 * @param init - fetch 选项（method / body）。
 * @returns 状态码与解析后的 JSON（非 JSON 响应时为 `undefined`）。
 */
export async function api(
  app: E2eApp,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown }> {
  // 不用 `...init.headers` 展开：HeadersInit 可能是数组或 Headers，展开会变成索引表。
  const headers = new Headers(init.headers)
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  const res = await fetch(`${app.baseUrl}${path}`, { ...init, headers })
  const text = await res.text()
  let json: unknown
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

/**
 * 在目标库上执行带参数的一条语句。
 *
 * 通过 psql 的 `-v` 变量传参，避免把播种数据拼进 SQL 文本（`.ai-spec/20-security.md`
 * 的红线要求参数化）。语句**必须经 stdin 传入**：psql 的变量插值只在脚本输入
 * （stdin / `-f`）下生效，用 `-c` 时 `:'name'` 会原样送到服务端并报语法错误。
 * @param url - 目标库连接串。
 * @param sql - 语句，值处写 `:'name'` 占位。
 * @param vars - 变量名到值的映射。
 * @param tuplesOnly - 是否只取元组输出（`-tA`）。
 * @returns psql 的标准输出。
 */
export function runParameterizedSql(
  url: string,
  sql: string,
  vars: Readonly<Record<string, string>>,
  tuplesOnly = false,
): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const args = ['exec', '-i', 'agenthub-postgres', 'psql', url]
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${value}`)
  if (tuplesOnly) args.push('-tA')
  return execFileSync('docker', args, { encoding: 'utf8', input: sql })
}
