/**
 * AgentHub console, browser half: the console sections (Tool 中心 / 系统连接 /
 * 审批中心 / AI 运营 / 项目设置), each as its own `main` keyed panel with a
 * `sidebar.panellist` entry sharing the panel id. Sidebar buttons select the
 * panels directly — there is no intermediate console home.
 */

import { createElement, type ComponentType, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot the panel registers into, and the
// panel id brand (ui-layout); the `sidebar.panellist` list the entry registers
// into (ui-sidebar); the renderer-owned slots service; the ctx.locale merge.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconFolderOpenOutlineRegular,
  IconGaugeOutlineRegular,
  IconFlatListOutlineRegular,
  IconLinkOutlineRegular,
  IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgenthubApi } from './api.ts'
import { httpApi } from './api.ts'
import { AnalyticsView } from './views/AnalyticsView.tsx'
import { AuditView } from './views/AuditView.tsx'
import { ConnectionsView } from './views/ConnectionsView.tsx'
import { ApprovalView } from './views/ModuleViews.tsx'
import { ProjectSettingsView } from './views/ProjectSettingsView.tsx'
import { ProjectChatButton } from './views/ProjectChatButton.tsx'
import { BusinessToolView } from './views/BusinessToolView.tsx'
import { ToolsView, type ModuleViewProps } from './views/ToolsView.tsx'
import { en, zh, type AgenthubLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AgentHub console copy. */
    'agenthub': AgenthubLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'agenthub'

/** Services required by the sidebar registration and the locale dictionaries. */
export const inject = ['slots', 'locale', 'uiWorkspace', 'workspaces', 'layout', 'sidebarRight'] as const

/** One sidebar section: its main panel key, label, icon, and page component. */
interface Section {
  readonly key: MainPanelId
  readonly labelKey: AgenthubLocaleKey
  readonly Glyph: ComponentType<{ size?: number | undefined }>
  readonly View: (props: ModuleViewProps) => ReactNode
}

/** The console sections, in sidebar order. */
const SECTIONS: readonly Section[] = [
  { key: 'agenthub-tools' as MainPanelId, labelKey: 'panel.tools', Glyph: IconSlidersTwoOutlineRegular, View: ToolsView },
  { key: 'agenthub-connections' as MainPanelId, labelKey: 'panel.connections', Glyph: IconLinkOutlineRegular, View: ConnectionsView },
  { key: 'agenthub-approvals' as MainPanelId, labelKey: 'panel.approvals', Glyph: IconShieldOutlineRegular, View: ApprovalView },
  { key: 'agenthub-analytics' as MainPanelId, labelKey: 'panel.analytics', Glyph: IconGaugeOutlineRegular, View: AnalyticsView },
  { key: 'agenthub-audit' as MainPanelId, labelKey: 'panel.audit', Glyph: IconFlatListOutlineRegular, View: AuditView },
  { key: 'agenthub-project' as MainPanelId, labelKey: 'panel.project', Glyph: IconFolderOpenOutlineRegular, View: ProjectSettingsView },
] as const

/** Full section props assembled by the main slot renderer. */
type SectionProps = PropsRuntime<'main'> & PropsLocale<'agenthub'> & InjectFace<{ api: AgenthubApi }>

/**
 * Adapt a module view to the section panel's composed props.
 * @param View - the module page component.
 * @returns the wrapped panel component.
 */
function sectionView(View: Section['View']): (props: SectionProps) => ReactNode {
  return function SectionView(props: SectionProps): ReactNode {
    return createElement(View, { t: props.t, api: props.api })
  }
}

/**
 * Adapt a primitives glyph to the sidebar icon share.
 * @param Glyph - the icon component.
 * @returns the sidebar icon component.
 */
function sectionIcon(Glyph: Section['Glyph']): (props: PropsRuntime<'sidebar.panellist'>) => ReactNode {
  return function SectionIcon(props: PropsRuntime<'sidebar.panellist'>): ReactNode {
    return createElement(Glyph, { size: props.size })
  }
}

/**
 * Client plugin body: the four console sections and their sidebar entries.
 * @param ctx - client root context.
 */
interface WorkspaceNavigation {
  startSession(workspaceId?: string): void
}

interface WorkspaceDirectory {
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

interface PanelNavigation {
  selectPanel(id: string | null): void
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agenthub-ui: dictionaries')
  const t = ctx.locale.bind(NS)
  const workspace = ctx.get('uiWorkspace') as WorkspaceNavigation
  const directories = ctx.get('workspaces') as WorkspaceDirectory
  const layout = ctx.get('layout') as PanelNavigation

  for (const [index, section] of SECTIONS.entries()) {
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: section.key,
      locale: NS,
      inject: () => ({ api: httpApi }),
    }, sectionView(section.View)))

    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: section.key,
      order: 40 + index,
      label: () => t(section.labelKey),
      locale: NS,
    }, sectionIcon(section.Glyph)))
  }

  const sidebarRight = ctx.get('sidebarRight')
  const registered = new Set<string>()
  const registerBusinessViews = (names: readonly string[]): void => {
    for (const name of names) {
      if (registered.has(name)) continue
      registered.add(name)
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: name,
        locale: NS,
      }, function BusinessToolSlot(props: PropsRuntime<'tool.call.toolview'> & PropsLocale<'agenthub'>) {
        return createElement(BusinessToolView, {
          toolName: props.toolName,
          ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
          phase: props.phase,
          ...(props.phase === 'result' ? { block: props.block } : {}),
          t: props.t,
          getLoginState: (tool, cwd) => httpApi.getLoginState(tool, cwd),
          startLogin: connectionId => httpApi.startConnectionLogin(connectionId),
          openBrowser: (url) => { sidebarRight?.openTab('browser', { params: { url } }) },
        })
      }))
    }
  }
  ctx.effect(() => {
    const load = (): void => {
      void httpApi.listBusinessTools().then(registerBusinessViews, () => {
        /* 名单失败时保留已注册的卡片，下次再拉 */
      })
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => { clearInterval(timer) }
  }, 'agenthub-ui: business tool views')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'agenthub-pick-project',
    order: 10,
    locale: NS,
  }, function PickProject(props: { wide: boolean; t: (key: AgenthubLocaleKey) => string }) {
    return createElement(ProjectChatButton, {
      wide: props.wide,
      t: props.t,
      listProjects: () => httpApi.listProjectOptions(),
      openProjectChat: (projectId) => httpApi.openProjectChat(projectId),
      adoptWorkspace: (path) => directories.create({ path }),
      startSession: (workspaceId) => { workspace.startSession(workspaceId) },
      openProjectSettings: () => { layout.selectPanel('agenthub-project') },
      showChat: () => { layout.selectPanel(null) },
    })
  }))
}
