/**
 * Mock records for the console pages, transcribed from the prototype's
 * `原型/assets/js/data.js` with enums per docs/api-contracts.md. Mock values
 * are display placeholders only: P3 replaces `mockApi` bodies with real
 * `/agenthub/api/*` calls and this file becomes fixture material for tests.
 */

import type {
  AgenthubApi, AnalyticsRecord, ApprovalRecord, BadcaseRecord, ConnectionHealthRecord, CreatedConnection,
  ProjectOption, ProjectSettingsRecord, RoleRecord, TaskRecord, ToolRecord, UserRecord,
} from '../api.ts'

const tools: readonly ToolRecord[] = [
  { id: 't1', name: '查询客户', api: 'query_customer', method: 'GET', path: '/customer/list', source: 'CRM Production', risk: 'read', approval: false, status: 'enabled', usedBy: ['p1'], desc: '按条件分页查询客户列表，支持等级/负责人/最后跟进时间过滤。', params: '{"level":"string","ownerId":"string","lastFollowBefore":"date","page":"int","size":"int"}', result: '{"total":36,"items":[{"id":"C10231","name":"华东智造","level":"A","lastFollow":"2026-09-19"}]}' },
  { id: 't2', name: '查询订单', api: 'query_orders', method: 'GET', path: '/order/list', source: 'CRM Production', risk: 'read', approval: false, status: 'enabled', usedBy: ['p1', 'p3'], desc: '查询订单列表，支持状态、金额区间、时间范围过滤。', params: '{"status":"string","amountMin":"number","dateFrom":"date","dateTo":"date"}', result: '{"total":12,"items":[{"id":"A001","amount":128000,"status":"待发货"}]}' },
  { id: 't3', name: '查询跟进记录', api: 'query_followups', method: 'GET', path: '/customer/{id}/followups', source: 'CRM Production', risk: 'read', approval: false, status: 'enabled', usedBy: ['p1'], desc: '查询指定客户的跟进记录（电话/拜访/微信）。', params: '{"customerId":"string","limit":"int"}', result: '{"items":[{"type":"电话","at":"2026-09-12","by":"张三"}]}' },
  { id: 't4', name: '创建跟进任务', api: 'create_follow_task', method: 'POST', path: '/task/create', source: 'CRM Production', risk: 'write', approval: true, status: 'enabled', usedBy: ['p1'], desc: '为客户创建跟进任务，指定时间与负责人。', params: '{"customerId":"string","dueAt":"datetime","title":"string"}', result: '{"taskId":"T-9921","created":true}' },
  { id: 't5', name: '修改订单金额', api: 'update_order_amount', method: 'PUT', path: '/order/{id}/amount', source: 'OMS 订单中心', risk: 'write', approval: true, status: 'enabled', usedBy: ['p3'], desc: '修改指定订单的成交金额，需填写调整原因。', params: '{"orderId":"string","amount":"number","reason":"string"}', result: '{"updated":true}' },
  { id: 't6', name: '删除订单', api: 'delete_order', method: 'DELETE', path: '/order/{id}', source: 'OMS 订单中心', risk: 'critical', approval: true, status: 'enabled', usedBy: [], desc: '删除订单及其关联数据，操作不可恢复。', params: '{"orderId":"string"}', result: '{"deleted":true}' },
  { id: 't7', name: '删除客户', api: 'delete_customer', method: 'DELETE', path: '/customer/{id}', source: 'CRM Production', risk: 'critical', approval: true, status: 'disabled', usedBy: [], desc: '删除客户档案，操作不可恢复。', params: '{"customerId":"string"}', result: '{"deleted":true}' },
  { id: 't8', name: '查询库存', api: 'query_stock', method: 'GET', path: '/stock/query', source: 'ERP 库存中心', risk: 'read', approval: false, status: 'enabled', usedBy: ['p2'], desc: '按 SKU / 仓库查询实时库存与在途数量。', params: '{"sku":"string","warehouse":"string"}', result: '{"items":[{"sku":"SKU-2201","qty":148,"onway":60}]}' },
  { id: 't9', name: '创建入库单', api: 'create_inbound', method: 'POST', path: '/stock/inbound', source: 'ERP 库存中心', risk: 'write', approval: true, status: 'enabled', usedBy: ['p2'], desc: '创建采购入库单并占用收货额度。', params: '{"sku":"string","qty":"int","warehouse":"string"}', result: '{"docNo":"IN-2026-0913"}' },
  { id: 't10', name: '查询客户画像', api: 'customer_profile', method: 'GET', path: '/customer/{id}/profile', source: 'CRM Production', risk: 'read', approval: false, status: 'draft', usedBy: [], desc: '聚合客户基本信息、交易历史与行为标签。', params: '{"customerId":"string"}', result: '{}' },
  { id: 't11', name: '发货操作', api: 'ship_order', method: 'POST', path: '/order/{id}/ship', source: 'OMS 订单中心', risk: 'write', approval: true, status: 'enabled', usedBy: ['p3'], desc: '对订单执行发货，生成物流单。', params: '{"orderId":"string","carrier":"string"}', result: '{"trackingNo":"SF1324579"}' },
  { id: 't12', name: '导出报表', api: 'export_report', method: 'POST', path: '/report/export', source: 'ERP 库存中心', risk: 'read', approval: false, status: 'disabled', usedBy: [], desc: '导出库存/销售报表（异步任务，返回下载链接）。', params: '{"type":"string","dateRange":"string"}', result: '{}' },
]

const approvals: readonly ApprovalRecord[] = [
  { id: 'ap1', user: '张三', project: '订单履约', toolName: 'delete_order', toolLabel: '删除订单', risk: 'critical', detail: '删除订单 A001（金额 ¥128,000），此操作不可恢复。', createdAt: '14:10', status: 'pending' },
  { id: 'ap2', user: '王五', project: '销售管理系统', toolName: 'update_customer_level', toolLabel: '批量修改客户等级', risk: 'write', detail: '将 14 个客户等级由 B 调整为 A。', createdAt: '13:31', status: 'pending' },
  { id: 'ap3', user: '李四', project: '库存运营', toolName: 'create_inbound', toolLabel: '创建入库单', risk: 'write', detail: 'SKU-2201 × 200 入华东仓。', createdAt: '11:02', status: 'approved' },
  { id: 'ap4', user: '张三', project: '订单履约', toolName: 'delete_order', toolLabel: '删除订单', risk: 'critical', detail: '删除订单 A007。', createdAt: '昨天 17:20', status: 'rejected' },
]

const badcases: readonly BadcaseRecord[] = [
  { id: 'b1', question: '帮我查一下上个月成交的华东客户有哪些', answer: '为您找到 3 位华东客户…（漏掉 11 条，按创建时间而非成交时间过滤）', cause: 'bad_param', causeDetail: 'dateFrom/dateTo 传成了 createdAt 区间，应为 dealTime。', project: '销售管理系统', user: '张三', status: 'open', createdAt: '今天 14:26', session: '重点客户分析', tool: 'query_customer' },
  { id: 'b2', question: '把 A001 订单的收货地址改一下', answer: '抱歉，我没有找到可以修改订单地址的工具。', cause: 'wrong_tool', causeDetail: 'Project Tool Set 未分配 update_order_address。', project: '订单履约', user: '王五', status: 'resolved', createdAt: '今天 11:03', session: 'A001 卡单处理', tool: '—' },
  { id: 'b3', question: '为什么库存数量和报表对不上？', answer: '引用了已过期的 Token 缓存数据，数字错误。', cause: 'permission_denied', causeDetail: 'ERP 凭证过期后回退到缓存快照，未提示重新授权。', project: '库存运营', user: '李四', status: 'open', createdAt: '昨天 16:40', session: '华东仓缺货预警', tool: 'query_stock' },
  { id: 'b4', question: '总结这个月的会议内容', answer: '把「会议」理解为 CRM 跟进活动，答非所问。', cause: 'model_misunderstanding', causeDetail: '「会议总结」Skill 未分配给此 Project。', project: '销售管理系统', user: '钱七', status: 'resolved', createdAt: '昨天 10:12', session: '9月销售复盘', tool: '—' },
]

const projectOptions: readonly ProjectOption[] = [
  { id: 'p1', name: '销售管理系统', workspaceId: 'ws-p1' },
  { id: 'p2', name: '库存运营', workspaceId: 'ws-p2' },
  { id: 'p3', name: '订单履约', workspaceId: 'ws-p3' },
]

/* Project settings are per-project isolated: one record per project, matching
   the prototype's p1/p2/p3 trees (agent binding, Tool Set, memory, files,
   members each follow the project, never shared). */
const projectSettings: readonly ProjectSettingsRecord[] = [
  {
    id: 'p1',
    name: '销售管理系统',
    system: 'CRM Production',
    agent: {
      name: 'Sales Agent',
      model: 'deepseek-chat',
      desc: '销售域默认 Agent，绑定 CRM Tool Set 与客户跟进 Skills。',
      approval: 'WRITE 需确认 / CRITICAL 需审批',
      memory: 'Project Memory + Session',
      skills: ['客户跟进分析', '月度销售复盘'],
      mcp: [],
    },
    toolSet: ['t1', 't2', 't3', 't4'],
    toolOptions: [
      { id: 't1', name: '查询客户', api: 'query_customer', risk: 'read' },
      { id: 't2', name: '查询订单', api: 'query_orders', risk: 'read' },
      { id: 't3', name: '查询跟进记录', api: 'query_followups', risk: 'read' },
      { id: 't4', name: '创建跟进任务', api: 'create_follow_task', risk: 'write' },
    ],
    memories: [
      { id: 'mm1', projectId: 'p1', content: '高意向客户超过 7 天未跟进 → 视为重点客户，需当日创建跟进任务。', status: 'active', locked: true, deleted: false, sourceSessionId: null, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' },
      { id: 'mm2', projectId: 'p1', content: '华东智造是 A 级客户，决策链：采购总监 → CTO，报价需含实施服务。', status: 'active', locked: false, deleted: false, sourceSessionId: null, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
      { id: 'mm3', projectId: 'p1', content: '销售复盘口径：成交金额按回款计，不含未开票合同。', status: 'active', locked: true, deleted: false, sourceSessionId: null, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' },
      { id: 'mm4', projectId: 'p1', content: '客户等级 A/B/C 的判定标准以 CRM 中 level 字段为准，不要自行推断。', status: 'active', locked: false, deleted: false, sourceSessionId: null, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' },
    ],
    memoryCandidates: [],
    files: [
      { id: 'f1', name: '2026-Q3-客户名单.xlsx', size: '1.2 MB', inCtx: true, updated: '今天' },
      { id: 'f2', name: '产品报价手册 V5.pdf', size: '8.4 MB', inCtx: true, updated: '3 天前' },
      { id: 'f3', name: '华东智造-会议纪要.docx', size: '36 KB', inCtx: false, updated: '昨天' },
    ],
    members: [
      { name: '张三', role: 'Project Admin', email: 'zhangsan@agenthub.local', joined: '2026-06' },
      { name: '李四', role: 'Member', email: 'lisi@agenthub.local', joined: '2026-06' },
      { name: '王五', role: 'Member', email: 'wangwu@agenthub.local', joined: '2026-07' },
      { name: '钱七', role: 'Auditor', email: 'qianqi@agenthub.local', joined: '2026-08' },
    ],
  },
  {
    id: 'p2',
    name: '库存运营',
    system: 'ERP 库存中心',
    agent: {
      name: 'Inventory Agent',
      model: 'deepseek-chat',
      desc: '库存运营 Agent，专注库存查询与入库建议。',
      approval: 'WRITE 需确认',
      memory: 'Project Memory',
      skills: ['库存健康度检查'],
      mcp: ['internal-wiki-mcp'],
    },
    toolSet: ['t8', 't9'],
    toolOptions: [
      { id: 't8', name: '查询库存', api: 'query_stock', risk: 'read' },
      { id: 't9', name: '创建入库单', api: 'create_inbound', risk: 'write' },
    ],
    memories: [
      { id: 'mm5', projectId: 'p2', content: '安全库存 = 近 30 天日均出库 × 1.5，低于该值触发补货建议。', status: 'active', locked: true, deleted: false, sourceSessionId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
    memoryCandidates: [],
    files: [
      { id: 'f4', name: 'SKU-主数据.csv', size: '2.1 MB', inCtx: true, updated: '5 天前' },
    ],
    members: [
      { name: '李四', role: 'Project Admin', email: 'lisi@agenthub.local', joined: '2026-07' },
    ],
  },
  {
    id: 'p3',
    name: '订单履约',
    system: 'OMS 订单中心',
    agent: {
      name: 'Order Ops Agent',
      model: 'deepseek-reasoner',
      desc: '订单履约 Agent，处理异常订单诊断与发货跟进。',
      approval: 'WRITE 需确认 / CRITICAL 需审批',
      memory: 'Project Memory + Session',
      skills: ['异常订单诊断'],
      mcp: ['oms-mcp-server'],
    },
    toolSet: ['t5', 't11'],
    toolOptions: [
      { id: 't5', name: '修改订单金额', api: 'update_order_amount', risk: 'write' },
      { id: 't6', name: '删除订单', api: 'delete_order', risk: 'critical' },
      { id: 't11', name: '发货操作', api: 'ship_order', risk: 'write' },
    ],
    memories: [
      { id: 'mm6', projectId: 'p3', content: '超时订单定义：待发货状态超过 48 小时。', status: 'active', locked: false, deleted: false, sourceSessionId: null, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
    ],
    memoryCandidates: [],
    files: [
      { id: 'f5', name: '物流商对账表-9月.xlsx', size: '640 KB', inCtx: false, updated: '2 天前' },
    ],
    members: [
      { name: '王五', role: 'Project Admin', email: 'wangwu@agenthub.local', joined: '2026-07' },
    ],
  },
]

/* `auth` mirrors the server's `connections.authMode` value domain so the card
   affordances (session authorize vs. token binding) select correctly. */
const connections: readonly ConnectionHealthRecord[] = [
  { id: 'c1', name: 'CRM Production', baseUrl: 'https://crm.acme.com/api/v2', frontendUrl: 'https://crm.acme.com', projectId: null, pendingHosts: [], type: 'openapi', auth: 'oauth2', status: 'healthy', tools: 16, lastCheck: '2 分钟前', allowedHosts: [] },
  { id: 'c2', name: 'ERP 库存中心', baseUrl: 'https://erp.acme.com/api', frontendUrl: 'https://erp.acme.com', projectId: null, pendingHosts: [], type: 'openapi', auth: 'pat', status: 'healthy', tools: 21, lastCheck: '8 分钟前', allowedHosts: [] },
  { id: 'c3', name: 'OMS 订单中心', baseUrl: 'https://oms.acme.com/openapi', frontendUrl: 'https://oms.acme.com', projectId: null, pendingHosts: [], type: 'manual', auth: 'session', status: 'degraded', tools: 14, lastCheck: '1 小时前', allowedHosts: [] },
]

const analytics: AnalyticsRecord = {
  kpi: { dau: 34, sessions: 128, toolCalls: 2143, successRate: 96.2, badcaseRate: 1.8, approvalRate: 12.4 },
  deltas: { dau: 8, sessions: 15, toolCalls: 21, successRate: 1, badcaseRate: -1, approvalRate: null },
  toolTrend: [120, 145, 132, 178, 165, 190, 210, 188, 224, 241, 230, 268, 252, 287],
  failCauses: [
    { cause: 'bad_param', count: 31 },
    { cause: 'upstream_error', count: 24 },
    { cause: 'model_misunderstanding', count: 18 },
    { cause: 'permission_denied', count: 14 },
    { cause: 'timeout', count: 9 },
    { cause: 'prompt_injection', count: 4 },
  ],
  topTools: [
    { api: 'query_customer', count: 412 },
    { api: 'query_orders', count: 356 },
    { api: 'query_stock', count: 289 },
    { api: 'create_follow_task', count: 198 },
    { api: 'query_followups', count: 154 },
  ],
}

const tasks: readonly TaskRecord[] = [
  { id: 'k1', name: '导出库存报表（9 月）', type: 'export', status: 'running', createdAt: '14:20' },
  { id: 'k2', name: 'OpenAPI 重扫 CRM Production', type: 'scan', status: 'queued', createdAt: '14:12' },
  { id: 'k3', name: 'Memory 全量重建（销售管理系统）', type: 'memory', status: 'done', createdAt: '13:05' },
]

const users: readonly UserRecord[] = [
  { id: 'u1', name: '张三', email: 'zhangsan@agenthub.local', role: 'Platform Admin', active: true },
  { id: 'u2', name: '李四', email: 'lisi@agenthub.local', role: 'Project Admin', active: true },
  { id: 'u3', name: '王五', email: 'wangwu@agenthub.local', role: 'Member', active: true },
  { id: 'u4', name: '赵六', email: 'zhaoliu@agenthub.local', role: 'Member', active: false },
  { id: 'u5', name: '钱七', email: 'qianqi@agenthub.local', role: 'Auditor', active: true },
]

const roles: readonly RoleRecord[] = [
  { name: 'Platform Admin', desc: '平台管理员：全局配置、系统连接、Tool Registry、用户与权限', members: 2, builtin: true },
  { name: 'Project Admin', desc: '项目管理员：管理 Project 成员、Tool Set、Memory、Agent', members: 4, builtin: true },
  { name: 'Member', desc: '成员：在 Project 内发起会话、调用已分配 Tool、确认写操作', members: 18, builtin: true },
  { name: 'Auditor', desc: '审计员：只读查看执行日志、Badcase、审批记录', members: 3, builtin: false },
]

/* Mutable in-process copies behind the write methods: fixtures only — real
   persistence belongs to the server API, so tests can still observe the effect
   of a decide/enable/create within one process. */
let liveTools: readonly ToolRecord[] = tools
let liveApprovals: readonly ApprovalRecord[] = approvals
let liveConnections: readonly ConnectionHealthRecord[] = connections
let liveProjectOptions: readonly ProjectOption[] = projectOptions
/** Mutable badcase rows so marking/resolving is observable within one process. */
const liveBadcases: BadcaseRecord[] = [...badcases]

/** The mock seam implementation wired into the console registration until P3 lands the real API. */
export const mockApi: AgenthubApi = {
  listTools: () => Promise.resolve(liveTools),
  listProjectOptions: () => Promise.resolve(liveProjectOptions),
  openProjectChat: (projectId) => {
    const found = liveProjectOptions.find(item => item.id === projectId)
    return Promise.resolve({
      workspaceId: found?.workspaceId ?? `ws-${projectId}`,
      workspacePath: `/workspaces/${projectId}`,
    })
  },
  // Mock creation: appends to the option list so the picker sees it in-process.
  createProject: (input) => {
    const option: ProjectOption = {
      id: `p${liveProjectOptions.length + 1}`,
      name: input.name,
      workspaceId: `ws-p${liveProjectOptions.length + 1}`,
    }
    liveProjectOptions = [...liveProjectOptions, option]
    return Promise.resolve(option)
  },
  // Prototype fixtures carry no extraction candidates (`memoryCandidates: []` inline):
  // candidates only appear once a real session produces them (阶段 C2 renders the section).
  listProjectSettings: () => Promise.resolve(projectSettings),
  listProjectSettingsFor: (projectId) => {
    const found = projectSettings.find(item => item.id === projectId)
    return found === undefined
      ? Promise.reject(new Error(`project not found: ${projectId}`))
      : Promise.resolve(found)
  },
  listApprovals: () => Promise.resolve(liveApprovals),
  listBadcases: () => Promise.resolve(liveBadcases),
  /**
   * In-memory badcase marking for the prototype seam.
   *
   * Mirrors the server contract loosely: repeat calls for one audit record update
   * the existing row instead of appending, which is what the page relies on to
   * show a single verdict per call.
   */
  markBadcase: (input) => {
    const existing = liveBadcases.find(row => row.tool === input.auditId)
    if (existing !== undefined) {
      Object.assign(existing, { cause: input.cause, causeDetail: input.note ?? '', status: 'open' })
      return Promise.resolve(existing)
    }
    const marked: BadcaseRecord = {
      id: `bc-${String(liveBadcases.length + 1)}`,
      question: '',
      answer: '',
      cause: input.cause,
      causeDetail: input.note ?? '',
      project: '',
      user: '',
      status: 'open',
      createdAt: new Date().toISOString(),
      session: '',
      tool: input.auditId,
    }
    liveBadcases.unshift(marked)
    return Promise.resolve(marked)
  },
  resolveBadcase: (id) => {
    const target = liveBadcases.find(row => row.id === id)
    if (target === undefined) return Promise.reject(new Error(`badcase not found: ${id}`))
    Object.assign(target, { status: 'resolved' })
    return Promise.resolve()
  },
  listBusinessTools: () => Promise.resolve([]),
  getLoginState: () => Promise.resolve({
    connectionId: '00000000-0000-4000-8000-000000000099',
    connectionName: 'Mock',
    status: 'missing',
  }),
  startConnectionLogin: () => Promise.resolve({ url: 'http://login.test/enter?ticket=mock' }),
  listConnectionHealth: () => Promise.resolve(liveConnections),
  listTasks: () => Promise.resolve(tasks),
  listUsers: () => Promise.resolve(users),
  listRoles: () => Promise.resolve(roles),
  getAnalytics: () => Promise.resolve(analytics),
  decideApproval: (id, decision) => {
    const target = liveApprovals.find(row => row.id === id)
    if (target === undefined) return Promise.reject(new Error(`approval not found: ${id}`))
    if (target.status !== 'pending') return Promise.reject(new Error(`approval already decided: ${id}`))
    const decided: ApprovalRecord = { ...target, status: decision === 'approve' ? 'approved' : 'rejected' }
    liveApprovals = liveApprovals.map(row => (row.id === id ? decided : row))
    return Promise.resolve(decided)
  },
  setToolEnabled: (id, enabled) => {
    liveTools = liveTools.map(row => (row.id === id ? { ...row, status: enabled ? 'enabled' : 'disabled' } : row))
    return Promise.resolve()
  },
  enableAllTools: (projectId) => {
    const updated = liveTools.filter(row => row.usedBy.includes(projectId) && row.status !== 'enabled').length
    liveTools = liveTools.map(row => (
      row.usedBy.includes(projectId) && row.status !== 'enabled' ? { ...row, status: 'enabled' } : row
    ))
    return Promise.resolve({ updated })
  },
  deleteTool: (projectId, toolId) => {
    const target = liveTools.find(row => row.id === toolId && row.usedBy.includes(projectId))
    if (target === undefined) return Promise.reject(new Error(`tool not found: ${toolId}`))
    liveTools = liveTools.filter(row => row.id !== toolId)
    return Promise.resolve()
  },
  deleteConnection: (id) => {
    if (!liveConnections.some(row => row.id === id)) return Promise.reject(new Error(`connection not found: ${id}`))
    liveConnections = liveConnections.filter(row => row.id !== id)
    return Promise.resolve()
  },
  deleteProject: (id) => {
    liveProjectOptions = liveProjectOptions.filter(item => item.id !== id)
    return Promise.resolve()
  },
  createConnection: (input) => {
    const created: ConnectionHealthRecord = {
      id: `mock-${liveConnections.length + 1}`,
      name: input.name,
      baseUrl: input.baseUrl,
      frontendUrl: input.frontendUrl,
      projectId: input.projectId,
      pendingHosts: [],
      type: input.openapiUrl === undefined ? 'manual' : 'openapi',
      auth: 'session',
      status: 'degraded',
      tools: 0,
      lastCheck: '—',
      allowedHosts: [],
    }
    liveConnections = [...liveConnections, created]
    const row: CreatedConnection = {
      id: created.id,
      name: created.name,
      baseUrl: created.baseUrl,
      authMode: 'session',
      openapiUrl: input.openapiUrl ?? null,
      hasOpenapiDoc: input.openapiUrl !== undefined,
      createdBy: 'mock-user',
      createdAt: '—',
      updatedAt: '—',
    }
    return Promise.resolve(row)
  },
  scanConnection: () => Promise.resolve({ created: [], skipped: [], total: 0 }),
  /** 原型里没有后台任务，进度恒为"已完成 0 条"，让弹窗走完终止态。 */
  getScanProgress: () => Promise.resolve(null),
  /**
   * Prototype allowlist write: replaces the stored list for one connection so the
   * page reflects an edit without a reload, mirroring the server's PUT.
   */
  setConnectionAllowlist: (id, allowedHosts) => {
    if (!liveConnections.some(row => row.id === id)) return Promise.reject(new Error(`connection not found: ${id}`))
    liveConnections = liveConnections.map(row => (row.id === id ? { ...row, allowedHosts } : row))
    return Promise.resolve()
  },
  bindCredential: input => Promise.resolve({ id: 'mock-credential', keyVersion: 1, expiresAt: input.expiresAt ?? null }),
  listMemories: (projectId, scope) => Promise.resolve(
    projectSettings
      .find(item => item.id === projectId)
      ?.memories.filter(row => !row.deleted && (scope === undefined || row.status === scope))
      ?? [],
  ),
  // Prototype fixtures carry no audit rows: the audit page is served by the real
  // API (阶段 C3-B), so the mock seam answers an empty page rather than inventing rows.
  listAudit: () => Promise.resolve({ items: [], total: 0 }),
  confirmMemory: (projectId, memoryId) => {
    const found = projectSettings.find(item => item.id === projectId)?.memories.find(row => row.id === memoryId)
    if (found === undefined) return Promise.reject(new Error(`memory not found: ${memoryId}`))
    return Promise.resolve({ ...found, status: 'active' })
  },
  rejectMemory: () => Promise.resolve(),
  setMemoryLocked: (projectId, memoryId, locked) => {
    const found = projectSettings.find(item => item.id === projectId)?.memories.find(row => row.id === memoryId)
    if (found === undefined) return Promise.reject(new Error(`memory not found: ${memoryId}`))
    return Promise.resolve({ ...found, locked })
  },
  deleteMemory: () => Promise.resolve(),
}
