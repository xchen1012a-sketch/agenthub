/**
 * CSS Modules 环境声明：`*.module.css` 的类名映射（构建期由打包器生成真实映射，
 * 源码视角下统一为 string → string 只读字典）。
 *
 * @module @agenthub/ui/css-modules
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
