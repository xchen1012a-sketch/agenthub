/**
 * Sidebar control that enters a business project's own conversation.
 * Picking a project starts a new session there. It does not move the chat
 * the employee already has open.
 */

import { useState, type ReactNode } from 'react'
import type { ProjectOption } from '../api.ts'
import type { Translate } from '../locales.ts'
import css from './ProjectChatButton.module.css'

/** What the button needs from the console: the project list, and where a pick goes. */
export interface ProjectChatButtonProps {
  readonly wide: boolean
  readonly t: Translate
  readonly listProjects: () => Promise<readonly ProjectOption[]>
  /** Ask the server for the project's live workspace, then let the conversation list adopt it. */
  readonly openProjectChat: (projectId: string) => Promise<{ workspacePath: string }>
  readonly adoptWorkspace: (path: string) => Promise<{ workspaceId: string }>
  readonly startSession: (workspaceId: string) => void
  readonly openProjectSettings: () => void
  readonly showChat: () => void
}

/**
 * Render the "choose project" control. An empty list sends the employee to
 * project settings instead of opening a folder.
 * @param props - column width, copy, and the actions a pick performs.
 * @returns the trigger and, once opened, the project list.
 */
export function ProjectChatButton(props: ProjectChatButtonProps): ReactNode {
  const { wide, t, listProjects, openProjectChat, adoptWorkspace, startSession, openProjectSettings, showChat } = props
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<readonly ProjectOption[] | null>(null)
  const [failed, setFailed] = useState(false)

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next) return
    setFailed(false)
    setProjects(null)
    void listProjects().then(
      (items) => { setProjects(items) },
      () => { setFailed(true) },
    )
  }

  const enter = (project: ProjectOption): void => {
    setFailed(false)
    void openProjectChat(project.id)
      .then(opened => adoptWorkspace(opened.workspacePath))
      .then((workspace) => {
        setOpen(false)
        showChat()
        startSession(workspace.workspaceId)
      })
      .catch(() => { setFailed(true) })
  }

  return (
    <div className={css.wrap}>
      <button type="button" className={css.trigger} aria-expanded={open} aria-label={t('chat.pickProject')} onClick={toggle}>
        {wide ? t('chat.pickProject') : '+'}
      </button>
      {open && (
        failed
          ? <p className={css.note} role="alert">{t('chat.pickProject.failed')}</p>
          : projects === null
            ? <p className={css.note} role="status">{t('chat.pickProject.loading')}</p>
            : projects.length === 0
              ? (
                <div>
                  <p className={css.note}>{t('chat.pickProject.empty')}</p>
                  <button type="button" className={css.link} onClick={() => { setOpen(false); openProjectSettings() }}>
                    {t('chat.pickProject.goSettings')}
                  </button>
                </div>
              )
              : (
                <ul className={css.menu} role="menu">
                  {projects.map(project => (
                    <li key={project.id}>
                      <button type="button" className={css.item} role="menuitem" onClick={() => { enter(project) }}>
                        {project.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )
      )}
    </div>
  )
}
