/**
 * i18n（U4：en / zh 双语同步，单语提交视为不完整）。
 *
 * @module @agenthub/ui/i18n
 */

export type Locale = 'en' | 'zh'

/** 文案键全集：en / zh 必须同键（i18n.spec 守护）。 */
export interface Messages {
  'app.title': string
  'login.hint': string
  'login.email': string
  'login.displayName': string
  'login.password': string
  'login.signIn': string
  'login.register': string
  'nav.projects': string
  'nav.sessions': string
  'nav.logout': string
  'projects.title': string
  'projects.new': string
  'projects.nameLabel': string
  'projects.namePlaceholder': string
  'projects.empty': string
  'projects.open': string
  'detail.title': string
  'detail.workspace': string
  'detail.empty': string
  'detail.back': string
  'sessions.title': string
  'sessions.empty': string
  'sessions.created': string
  'sessions.events': string
  'error.title': string
  'error.back': string
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    'app.title': 'AgentHub',
    'login.hint': 'Sign in with email and password, or create an account (password ≥ 8 chars).',
    'login.email': 'Email',
    'login.displayName': 'Display name',
    'login.password': 'Password',
    'login.signIn': 'Sign in',
    'login.register': 'Register',
    'nav.projects': 'Projects',
    'nav.sessions': 'Sessions',
    'nav.logout': 'Sign out',
    'projects.title': 'Projects',
    'projects.new': 'New Project',
    'projects.nameLabel': 'Project name',
    'projects.namePlaceholder': 'e.g. Platform Team',
    'projects.empty': 'No projects yet. Create the first one.',
    'projects.open': 'Open',
    'detail.title': 'Project detail',
    'detail.workspace': 'Workspace',
    'detail.empty': 'Tool loading and isolation are wired by project-tool-scope.',
    'detail.back': 'Back to projects',
    'sessions.title': 'Sessions',
    'sessions.empty': 'No stored sessions yet.',
    'sessions.created': 'Created',
    'sessions.events': 'Events',
    'error.title': 'Something went wrong',
    'error.back': 'Back',
  },
  zh: {
    'app.title': 'AgentHub',
    'login.hint': '使用邮箱密码登录，或注册新账号（密码至少 8 位）。',
    'login.email': '邮箱',
    'login.displayName': '显示名',
    'login.password': '密码',
    'login.signIn': '登录',
    'login.register': '注册',
    'nav.projects': '项目',
    'nav.sessions': '会话',
    'nav.logout': '退出登录',
    'projects.title': '项目列表',
    'projects.new': '新建项目',
    'projects.nameLabel': '项目名称',
    'projects.namePlaceholder': '例如：平台组',
    'projects.empty': '还没有项目，创建第一个吧。',
    'projects.open': '打开',
    'detail.title': '项目详情',
    'detail.workspace': 'Workspace',
    'detail.empty': '工具装载与隔离由 project-tool-scope 接管。',
    'detail.back': '返回项目列表',
    'sessions.title': '会话列表',
    'sessions.empty': '还没有持久化会话。',
    'sessions.created': '创建时间',
    'sessions.events': '事件数',
    'error.title': '出错了',
    'error.back': '返回',
  },
}

/** Accept-Language → Locale（q-weight 协商，RFC 7231 §5.3.4）。 */
export function pickLocale(acceptLanguage: string | undefined): Locale {
  if (acceptLanguage === undefined || acceptLanguage === '') return 'zh'
  const zhWeight = bestWeight(acceptLanguage, 'zh')
  const enWeight = bestWeight(acceptLanguage, 'en')
  if (zhWeight === 0 && enWeight === 0) return 'zh'
  return enWeight > zhWeight ? 'en' : 'zh'
}

/**
 * 解析 Accept-Language，取出 tag 与其 q 值；tag 可带 `-XX` 区域后缀。
 * 返回该 tag（及其派生）在整段 header 中的最大 q（缺省 1.0）。
 */
function bestWeight(header: string, tag: string): number {
  const re = new RegExp(`(^|,|\\s)(${tag}(?:-[A-Za-z]+)?)(?:;\\s*q=([\\d.]+))?`, 'gi')
  let best = 0
  for (const match of header.matchAll(re)) {
    // match[2] = full tag match（如 'zh-CN'），match[3] = q 值或 undefined
    const q = match[3] === undefined ? 1 : Number.parseFloat(match[3])
    if (Number.isFinite(q) && q > best) best = q
  }
  return best
}

export function t(locale: Locale, key: keyof Messages): string {
  return MESSAGES[locale][key]
}
