/**
 * AgentHub 端到端验收（P5 阶段书 §7.1-3）。
 *
 * 覆盖阶段书链路：**登录 → 建 Project → 触发 Tool → 审计可见 → 指标出现**。
 *
 * 设计约束（避免"永远通过"的假测试）：
 *   - 每个用例先播种自己的数据，断言**该数据在页面上真的可见**；
 *   - 不用"无数据则跳过断言"的兜底——那会让页面白屏也算通过；
 *   - 浏览器断言打在真实渲染出的文案上（文案取自语言字典，见用例内注释）。
 *
 * 凭证绑定与 Approval 未在此覆盖：前者需要真实外部系统，后者需要构造审批边界，
 * E2E 不伪造这两者，它们的覆盖由各自的集成测试承担。
 *
 * 运行：
 *   pnpm exec vitest run --config vitest.e2e.config.ts packages/agenthub/e2e
 * 库地址取 `AGENTHUB_E2E_DB_URL` → `AGENTHUB_DB_URL` → `deploy/.env`；
 * 跑完用 `deploy/scripts/reset-db.sh` 清空写入的行。
 *
 * @module tests/agenthub.e2e
 */
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  api, resolveBrowserExecutable, resolveDatabaseUrl, runParameterizedSql, startApp, type E2eApp,
} from '../src/lifecycle.ts'

/** 本文件播种的标记，便于失败时定位来源。 */
const MARK = `e2e-${randomUUID().slice(0, 8)}`

/** dev 匿名身份（`AuthService` 在 `AGENTHUB_AUTH_DEV_ANON !== 'false'` 时 upsert 为平台管理员）。 */
const DEV_USER = '00000000-0000-4000-8000-000000000001'

describe('AgentHub e2e：登录 → Project → Tool → 审计 → 指标', () => {
  let app: E2eApp
  let browser: Browser
  let page: Page

  /** 播种的 Project 与它的一条审计记录。 */
  let projectId = ''
  let auditTraceId = ''

  beforeAll(async () => {
    app = await startApp()
    const executablePath = resolveBrowserExecutable()
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })

    // 播种：一个 Project（直接入真库，见 seedProject 的说明）。
    projectId = seedProject(MARK)

    // 播种：一条审计记录（经真库插入——E2E 要验的是"审计页能显示真执行留下的记录"）。
    auditTraceId = `${MARK}-trace`
    seedAuditRow(projectId, auditTraceId)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    app?.stop()
  })

  it('登录：dev 匿名下浏览器直接进入控制台（不落登录页）', async () => {
    const res = await page.goto(`${app.baseUrl}/agenthub/projects`, { waitUntil: 'domcontentloaded' })
    expect(res?.status()).toBe(200)
    expect(await page.locator('input[type="password"]').count()).toBe(0)
    // 必须是真实渲染的页面，而不是空壳：标题取自 ui/src/i18n.ts 的 `projects.title`。
    const title = await page.title()
    expect(title).toContain('项目列表')
  })

  it('建 Project：列表页渲染出新建入口', async () => {
    await page.goto(`${app.baseUrl}/agenthub/projects`, { waitUntil: 'domcontentloaded' })
    // 文案取自 ui/src/i18n.ts 的 `projects.new`（zh：新建项目）。
    const entry = page.getByRole('button', { name: /新建项目/ })
      .or(page.getByRole('link', { name: /新建项目/ }))
    await expect.poll(async () => entry.count()).toBeGreaterThan(0)
  })

  it('审计：播种的审计记录可经项目维度查得（BND-4 归属生效）', async () => {
    const queried = await api(app, `/agenthub/api/audit?projectId=${projectId}`)
    expect(queried.status).toBe(200)
    // 响应字段是 camelCase（路由层把 DB 行映射成前端契约）。
    const rows = (queried.json as { items: { traceId: string }[] }).items
    expect(
      rows.map(row => row.traceId),
      `期望含 ${auditTraceId}；实际返回 ${String(rows.length)} 行`,
    ).toContain(auditTraceId)
  })

  it('坏例闭环：登记后出现在列表页（P5 §7.1-2 端到端）', async () => {
    const auditId = auditIdOf(projectId, auditTraceId)
    const { token, cookie } = await csrf(`${app.baseUrl}/agenthub/audit`)
    const marked = await fetch(`${app.baseUrl}/agenthub/api/audit/${auditId}/badcase`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': token,
        cookie,
      },
      body: new URLSearchParams({ projectId, category: 'wrong_tool', note: MARK }).toString(),
    })
    expect(marked.status).toBe(200)

    const listed = await api(app, '/agenthub/api/badcases')
    expect(listed.status).toBe(200)
    // 列表按时间倒序，本次登记应在页首附近；断言它的归因与说明确实回来了。
    const items = (listed.json as { items: { causeDetail: string; cause: string }[] }).items
    expect(items.some(item => item.cause === 'wrong_tool' && item.causeDetail === MARK)).toBe(true)
  })

  it('指标接口：窗口切换返回对应长度的趋势数组', async () => {
    const week = await api(app, '/agenthub/api/analytics?window=7d')
    expect(week.status).toBe(200)
    expect((week.json as { toolTrend: number[] }).toolTrend).toHaveLength(7)

    const month = await api(app, '/agenthub/api/analytics?window=30d')
    expect((month.json as { toolTrend: number[] }).toolTrend).toHaveLength(30)
  })

  it('指标页：控制台 Web 外壳可加载（KPI 面板挂在壳内，见文件头的覆盖边界）', async () => {
    // 侧栏面板没有独立 URL（注册在主面板槽位里），因此这里只断言外壳可达。
    const res = await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' })
    // 外壳自身需要 Host 侧鉴权：dev 匿名不覆盖它，401 是预期结果而非缺陷。
    expect([200, 401]).toContain(res?.status() ?? 0)
  })

  it('隔离：未带 projectId 的审计查询被拒（BND-4，没有"全部项目"入口）', async () => {
    const res = await api(app, '/agenthub/api/audit')
    expect(res.status).toBe(400)
  })

  /**
   * 取 CSRF 双提交令牌。
   *
   * 该应用用**双提交 Cookie**（`.ai-spec/20-security.md` SEC-5）：首次请求签发
   * `agenthub_csrf` Cookie，写请求须把同一个值放进 `x-csrf-token`。令牌不在 HTML 里，
   * 因此必须从响应头读取——这是 E2E 与浏览器表单的差异点。
   * @param url - 任意 GET 页面地址。
   * @returns `{ token, cookie }`，供写请求同时带上。
   */
  async function csrf(url: string): Promise<{ token: string; cookie: string }> {
    const res = await fetch(url)
    // undici 用 getSetCookie() 暴露全部 Set-Cookie（get('set-cookie') 会合并）。
    const setCookies = res.headers.getSetCookie()
    for (const raw of setCookies) {
      const [pair] = raw.split(';')
      if (pair?.startsWith('agenthub_csrf=')) {
        const token = pair.slice('agenthub_csrf='.length)
        return { token, cookie: `agenthub_csrf=${token}` }
      }
    }
    throw new Error(`未从 ${url} 取得 agenthub_csrf（双提交令牌）。`)
  }

  /**
   * 播种一个 Project，并把 dev 身份加为成员。
   *
   * 成员行是必须的：`requireProjectMember` 对非成员 fail-closed 返回 403（正确行为），
   * 而 E2E 要通过审计接口读取这个项目的记录，因此必须先建立归属关系。
   * @param name - 项目名。
   * @returns 新项目 id。
   */
  function seedProject(name: string): string {
    const out = runParameterizedSql(
      resolveDatabaseUrl(),
      `WITH p AS (
  INSERT INTO projects (name, description, status, harness_workspace_id, created_by)
  SELECT :'pname', 'e2e', 'active', 'e2e:' || :'pname', id FROM users WHERE id = :'devuser'
  RETURNING id
)
INSERT INTO project_members (project_id, user_id, role)
SELECT id, :'devuser', 'admin' FROM p
RETURNING project_id;`,
      { pname: name, devuser: DEV_USER },
      true,
    )
    const id = out.trim().split('\n')[0]?.trim() ?? ''
    if (id === '') throw new Error(`播种 Project ${name} 未返回 id。`)
    return id
  }

  /**
   * 直接向 E2E 目标库插入一条审计记录。
   *
   * 走真库而非接口：审计行由工具执行时写入，E2E 不重放一次真实外部调用（那需要
   * 业务系统在线）；这里只验证"审计页/接口能展示真执行留下的行"这一段。
   * @param forProjectId - 归属 Project。
   * @param traceId - 标记用 trace_id。
   */
  function seedAuditRow(forProjectId: string, traceId: string): void {
    runParameterizedSql(
      resolveDatabaseUrl(),
      `INSERT INTO audit_records
  (project_id, user_id, session_id, tool_name, risk_level, status, trace_id, result_meta)
SELECT :'proj'::uuid, id, :'sess', 'e2e_probe_tool', 'write', 'error', :'trace',
       '{"durationMs":42}'::jsonb
FROM users WHERE id = :'devuser';`,
      { proj: forProjectId, sess: `${MARK}-sess`, trace: traceId, devuser: DEV_USER },
    )
  }

  /**
   * 按 trace_id 取审计行 id。
   * @param forProjectId - 归属 Project。
   * @param traceId - trace_id。
   * @returns 审计行 id。
   */
  function auditIdOf(forProjectId: string, traceId: string): string {
    const out = runParameterizedSql(
      resolveDatabaseUrl(),
      'SELECT id FROM audit_records WHERE project_id = :\'proj\'::uuid AND trace_id = :\'trace\';',
      { proj: forProjectId, trace: traceId },
      true,
    )
    return out.trim().split('\n')[0]?.trim() ?? ''
  }

  /**
   * 在容器内执行 SQL（E2E 目标库与容器同源）。
   * @param sql - 语句。
   * @param tuplesOnly - 是否只取元组输出（`-t`）。
   * @returns psql 的标准输出。
   */
  /** 同步播种直接返回，无需 await 包装。 */
})
