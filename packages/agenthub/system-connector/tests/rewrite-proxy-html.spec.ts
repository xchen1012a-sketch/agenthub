import { describe, expect, it } from 'vitest'
import { resolveProxyTarget, rewriteModuleImports, rewriteProxyHtml } from '../src/proxy.ts'

const SAME_ORIGIN = {
  frontendUrl: 'http://localhost:48080',
  baseUrl: 'http://localhost:48080',
}
const SPLIT_ORIGIN = {
  frontendUrl: 'http://localhost:48080',
  baseUrl: 'http://localhost:48081',
}
const MOUNT = '/agenthub/connections/ba3815b1-afd3-4d05-b01b-7c4dd693ca9a/s/sess-1'
const LOGIN_HOST = 'login.test:5080'

describe('rewriteProxyHtml', () => {
  it('根路径 script 改写到会话前缀（Vite 开发页），<base> 指向登录站点', () => {
    const html = `<!DOCTYPE html><html><head></head><body>
<script type="module" src="/@vite/client"></script>
<script type="module" src="/src/main.ts"></script>
</body></html>`
    const out = rewriteProxyHtml(html, SAME_ORIGIN, MOUNT, LOGIN_HOST)
    expect(out).toContain(`src="${MOUNT}/@vite/client"`)
    expect(out).toContain(`src="${MOUNT}/src/main.ts"`)
    expect(out).toContain(`<base href="http://${LOGIN_HOST}${MOUNT}/">`)
  })

  it('绝对前端地址改写到会话前缀；后端地址改写到 _api', () => {
    const html = '<a href="http://localhost:48080/login">登录</a><script>var api="http://localhost:48081/v1"</script>'
    const out = rewriteProxyHtml(html, SPLIT_ORIGIN, MOUNT, LOGIN_HOST)
    expect(out).toContain(`href="http://${LOGIN_HOST}${MOUNT}/login"`)
    expect(out).toContain(`"http://${LOGIN_HOST}${MOUNT}/_api/v1"`)
    expect(out).not.toContain('localhost:48081/v1')
  })

  it('<head> 最前面注入不发 Referer 声明与请求改道脚本，脚本先于页面自身脚本', () => {
    const html = '<html><head><script src="/app.js"></script></head><body></body></html>'
    const out = rewriteProxyHtml(html, SPLIT_ORIGIN, MOUNT, LOGIN_HOST)
    const head = out.slice(out.indexOf('<head>') + '<head>'.length)
    expect(head.startsWith('<meta name="referrer" content="no-referrer">')).toBe(true)
    expect(out.indexOf('window.fetch')).toBeLessThan(out.indexOf(`src="${MOUNT}/app.js"`))
    expect(out).toContain('XMLHttpRequest.prototype.open')
  })

  it('没有 <head> 时补一个', () => {
    const out = rewriteProxyHtml('<html><body>x</body></html>', SAME_ORIGIN, MOUNT, LOGIN_HOST)
    expect(out.startsWith('<html><head><meta name="referrer"')).toBe(true)
  })
})

describe('rewriteModuleImports', () => {
  it('静态 / 动态 / 副作用导入的根路径改到会话前缀', () => {
    const source = [
      'import { a } from "/src/a.ts"',
      "import '/src/side.css'",
      'const m = import("/src/lazy.ts")',
      'export * from "/node_modules/.vite/deps/vue.js"',
    ].join('\n')
    const out = rewriteModuleImports(source, MOUNT)
    expect(out).toContain(`from "${MOUNT}/src/a.ts"`)
    expect(out).toContain(`import '${MOUNT}/src/side.css'`)
    expect(out).toContain(`import("${MOUNT}/src/lazy.ts")`)
    expect(out).toContain(`from "${MOUNT}/node_modules/.vite/deps/vue.js"`)
  })

  it('协议相对地址、相对路径与已改写路径不动', () => {
    const source = [
      'import x from "//cdn.test/x.js"',
      'import y from "./y.js"',
      `import z from "${MOUNT}/z.js"`,
    ].join('\n')
    expect(rewriteModuleImports(source, MOUNT)).toBe(source)
  })
})

describe('resolveProxyTarget', () => {
  it('空路径 → 前端地址；_api → 后端地址；其余相对前端', () => {
    expect(resolveProxyTarget('http://f.test/login', 'http://b.test', undefined, '')?.toString()).toBe('http://f.test/login')
    expect(resolveProxyTarget('http://f.test', 'http://b.test', '_api/v1/me', '?x=1')?.toString()).toBe('http://b.test/v1/me?x=1')
    expect(resolveProxyTarget('http://f.test', 'http://b.test', 'assets/a.js', '')?.toString()).toBe('http://f.test/assets/a.js')
  })

  it('越出两个源 → null', () => {
    expect(resolveProxyTarget('http://f.test', 'http://b.test', '/evil.test/x', '')).toBeNull()
  })
})
