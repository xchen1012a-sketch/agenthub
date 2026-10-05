# ui-primitives 盘点（AgentHub UI 接入 · 前置任务 3）

> 盘点对象：`packages/client/ui-primitives`（可直接 import 的 React 组件库 + `--dsw-*` design tokens）。
> 结论日期：2026-09-27。上游升级时随 slot-catalog 一并复核。

## 1. 结论速览

- **可直接复用**：Button / Input / Checkbox / Switch / SegmentedTabs / SegmentedControl / Tag / Pill / StateDot / Menu / MenuSurface / Modal / Toast / Tooltip / HoverCard / DisclosureRow / ConfigField / JsonTree / RiskConfirmation / PermissionIcon / Icon\* 族 / settings-form。
- **缺口**：无 **Table** 组件；无 **Drawer**（侧滑详情容器）。原型 5 处表格页与执行日志 Drawer 需自拼。

## 2. 原型元素 → 组件映射

| 原型元素（原型 v2） | 用什么 | 备注 |
| --- | --- | --- |
| 管理页表格（Tool 中心 / 审批中心 / 审计 / Badcase） | **自拼 Grid**：CSS grid + `--dsw-*` tokens | 先例：ui-primitives 各 `*.module.css` 的行/边框/斑马纹密度；抽一个包内共享 `AdminTable` 基元（P3 首页落地时定稿，后续页复用） |
| 页内 tabs（Tool 风险过滤 / Project 设置 / 运营总览-Badcase） | `SegmentedTabs` / `SegmentedControl` | 原型 `.rp-tab` 形态一致 |
| 风险徽标（READ/WRITE/CRITICAL） | `Tag` / `Pill` + 自定色调（tokens） | `PermissionIcon` 可用于权限/风险语义 |
| 状态点（连接状态 / 审批状态 / Session 状态） | `StateDot` | 原型 `UI.statusDot` 对应物 |
| 行内操作菜单 / 下拉 | `Menu` / `MenuSurface` | |
| Tool 详情展开（参数/结果） | `DisclosureRow` + `JsonTree` | 替代原型 `<pre>` 详情 |
| 高危确认 / 审批卡（对话内、页面内） | `RiskConfirmation` | P3 企业审批卡的基础 |
| 表单（添加连接 / 绑定凭证 / Project 设置） | `Input` / `Checkbox` / `Switch` / `ConfigField` / settings-form | settings-form 是上游设置页先例 |
| 提交反馈 | `Toast` | 替代原型 alert |
| 执行日志详情 Drawer | **无现成**：Modal 变体或自拼侧滑容器（fixed + tokens 阴影/圆角） | P4 定稿一种，全站复用 |
| 图表（AI 运营趋势/排行） | 无现成图表组件 | P5 自拼 SVG（低饱和、tokens 配色），或引入轻量方案时先过依赖评审 |

## 3. 使用规则（对齐上游）

- 组件零 Cordis 依赖，直接 `import { X } from '@deepseek-ai/dsh-client-ui-primitives'`；它在 PLATFORM_MODULES 共享表里，client bundle 以 external 引用（purity gate 放行）。
- 样式一律走 `--dsw-*` tokens，不引第三方 UI 库、不写全局 CSS。
- 图标统一 `Icon<X>OutlineRegular / Medium` 族（线性 SVG），尺寸由调用方传 `size`。
