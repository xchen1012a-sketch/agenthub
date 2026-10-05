/**
 * 服务端渲染页面（简洁风：单栏、系统字体、无装饰堆砌）。
 *
 * @module @agenthub/ui/render
 */
import { t, type Locale } from './i18n.ts'

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #fafafa; color: #1a1a1a; }
  main { max-width: 560px; margin: 12vh auto 0; padding: 0 16px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 20px; }
  h1 small { font-weight: 400; color: #888; margin-left: 8px; }
  nav { display: flex; gap: 16px; margin: 0 0 16px; font-size: 14px; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 24px; }
  .muted { color: #888; font-size: 13px; margin: 0 0 16px; }
  button, .btn { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #d4d4d4;
                 background: #fff; cursor: pointer; color: inherit; text-decoration: none; display: inline-block; }
  button:hover, .btn:hover { border-color: #a3a3a3; }
  button.primary { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  form.inline { display: flex; gap: 8px; margin: 0 0 20px; }
  form.stack { display: grid; gap: 10px; margin: 0 0 24px; }
  form.stack:last-child { margin-bottom: 0; }
  input[type=text], input[type=email], input[type=password] {
    font: inherit; flex: 1; padding: 6px 10px; border: 1px solid #d4d4d4; border-radius: 6px; width: 100%; }
  label { font-size: 13px; color: #555; display: grid; gap: 4px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; justify-content: space-between; align-items: center; padding: 10px 0;
       border-top: 1px solid #f0f0f0; }
  li:first-child { border-top: none; }
  a { color: inherit; }
`

export function layout(locale: Locale, title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · AgentHub</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${t(locale, 'app.title')}<small>${escapeHtml(title)}</small></h1>
<div class="card">
${body}
</div>
</main>
</body>
</html>`
}

/** 已登录页顶部导航（projects / sessions + 退出登录）。 */
function nav(locale: Locale): string {
  return `
<nav>
  <a href="/agenthub/projects">${t(locale, 'nav.projects')}</a>
  <a href="/agenthub/sessions">${t(locale, 'nav.sessions')}</a>
  <form method="post" action="/agenthub/logout" style="margin:0">
    <button type="submit">${t(locale, 'nav.logout')}</button>
  </form>
</nav>`
}

export function loginPage(locale: Locale, csrfToken: string, devAnon: boolean): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`
  const dev = devAnon
    ? `<form method="post" action="/agenthub/login">${csrf}<button class="primary" type="submit">${t(locale, 'login.signIn')} (dev)</button></form>`
    : `
<form class="stack" method="post" action="/agenthub/login">
  ${csrf}
  <label>${t(locale, 'login.email')}<input type="email" name="email" required></label>
  <label>${t(locale, 'login.password')}<input type="password" name="password" required></label>
  <button class="primary" type="submit">${t(locale, 'login.signIn')}</button>
</form>
<hr style="border:none;border-top:1px solid #f0f0f0;margin:0 0 24px">
<form class="stack" method="post" action="/agenthub/login">
  ${csrf}
  <input type="hidden" name="mode" value="register">
  <label>${t(locale, 'login.email')}<input type="email" name="email" required></label>
  <label>${t(locale, 'login.displayName')}<input type="text" name="displayName" required maxlength="100"></label>
  <label>${t(locale, 'login.password')}<input type="password" name="password" required minlength="8"></label>
  <button type="submit">${t(locale, 'login.register')}</button>
</form>`
  return layout(locale, t(locale, 'app.title'), `
<p class="muted">${t(locale, 'login.hint')}</p>
${dev}`)
}

export function projectsPage(
  locale: Locale,
  projects: readonly { id: string; name: string }[],
): string {
  const items = projects.length === 0
    ? `<p class="muted">${t(locale, 'projects.empty')}</p>`
    : `<ul>${projects.map(project => `
  <li><span>${escapeHtml(project.name)}</span><a class="btn" href="/agenthub/projects/${project.id}">${t(locale, 'projects.open')}</a></li>
</ul>`).join('')}`
  return layout(locale, t(locale, 'projects.title'), `
${nav(locale)}
<form class="inline" method="post" action="/agenthub/projects">
  <input type="text" name="name" required maxlength="200" placeholder="${t(locale, 'projects.namePlaceholder')}"
         aria-label="${t(locale, 'projects.nameLabel')}">
  <button class="primary" type="submit">${t(locale, 'projects.new')}</button>
</form>
${items}`)
}

export function projectDetailPage(locale: Locale, name: string, workspaceId: string): string {
  return layout(locale, t(locale, 'detail.title'), `
${nav(locale)}
<p><strong>${escapeHtml(name)}</strong></p>
<p class="muted">${t(locale, 'detail.workspace')}: ${escapeHtml(workspaceId)}</p>
<p class="muted">${t(locale, 'detail.empty')}</p>
<p><a class="btn" href="/agenthub/projects">${t(locale, 'detail.back')}</a></p>`)
}

/** 平台 Session 列表页（Harness Session 无用户维度，P2 限 platform_admin 查看）。 */
export function sessionsPage(
  locale: Locale,
  sessions: readonly { id: string; createdAt: number; eventCount?: number | undefined }[],
): string {
  const items = sessions.length === 0
    ? `<p class="muted">${t(locale, 'sessions.empty')}</p>`
    : `<ul>${sessions.map(session => `
  <li><span>${escapeHtml(session.id)}</span><span class="muted">${t(locale, 'sessions.created')} ${new Date(session.createdAt).toISOString()} · ${t(locale, 'sessions.events')} ${session.eventCount ?? 0}</span></li>
</ul>`).join('')}`
  return layout(locale, t(locale, 'sessions.title'), `
${nav(locale)}
${items}`)
}

export function errorPage(locale: Locale, message: string): string {
  return layout(locale, t(locale, 'error.title'), `
<p class="muted">${escapeHtml(message)}</p>
<p><a class="btn" href="/agenthub/projects">${t(locale, 'error.back')}</a></p>`)
}

/** 属性/文本注入兜底（所有插值必经；P1 页面无脚本，无双引号即可闭合属性）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
