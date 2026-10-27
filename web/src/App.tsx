import { useEffect, useSyncExternalStore } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CollectionDialog } from '@/components/collections'
import { CommandPalette } from '@/components/CommandPalette'
import { startComment } from '@/components/CommentsRail'
import { focusedArticle } from '@/lib/anchors'
import { closeFind, findControls, openFind } from '@/components/FindBar'
import { DiffDialog } from '@/components/DiffDialog'
import { closeEditor, isDirty, openEditor, saveDraft } from '@/lib/drafts'
import { openSearchPanel } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import { EmptyState } from '@/components/EmptyState'
import { GroupDialog } from '@/components/groups'
import { LeafMark } from '@/components/LeafMark'
import { OpenDialog } from '@/components/OpenDialog'
import { projectFor, recompile } from '@/lib/tex'
import { ShortcutsDialog } from '@/components/ShortcutsDialog'
import { togglePin } from '@/components/pins'
import { Panes } from '@/components/Panes'
import { Sidebar } from '@/components/Sidebar'
import { TabStrip } from '@/components/TabStrip'
import type { Theme } from '@/lib/api'
import { basename } from '@/lib/paths'
import { actions, currentSplit, getState, isPdf, setState, startSync, stepTab, useLeaf } from '@/lib/store'

function typing(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))
}

/** Single-key shortcuts apply only outside text fields; modifier shortcuts work everywhere. */
function onKey(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey
  const { workspace, sidebarOpen, outlineOpen, paletteOpen } = getState()
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    setState({ paletteOpen: !paletteOpen })
    return
  }
  if (mod && event.key === '\\') {
    event.preventDefault()
    setState({ sidebarOpen: !sidebarOpen })
    return
  }
  if (mod && event.key === '.') {
    event.preventDefault()
    setState({ outlineOpen: !outlineOpen })
    return
  }
  // ⌘⌥M, as in Google Docs: comment on the selection (works while text is selected).
  if (mod && event.altKey && event.code === 'KeyM' && workspace?.active) {
    event.preventDefault()
    startComment(workspace.active, focusedArticle())
    return
  }
  // ⌘S saves the active document's edits from anywhere; inside the editor CodeMirror already did.
  if (mod && event.key.toLowerCase() === 's' && workspace?.active && getState().drafts[workspace.active]) {
    if (!event.defaultPrevented) saveDraft(workspace.active)
    event.preventDefault()
    return
  }
  // ⌘F finds in the focused pane: in the editor when it shows one, otherwise in the document.
  // PDFs leave ⌘F to the browser, which searches their text layer.
  if (mod && !event.altKey && event.key.toLowerCase() === 'f' && workspace?.active && !isPdf(workspace.active) && !event.defaultPrevented) {
    event.preventDefault()
    const editor = document.querySelector<HTMLElement>('[data-pane-focused] .cm-editor')
    const view = editor && getState().editModes[workspace.active] === 'edit' ? EditorView.findFromDOM(editor) : null
    if (view) openSearchPanel(view)
    else openFind()
    return
  }
  if (mod && event.key.toLowerCase() === 'g' && getState().findOpen && findControls.step) {
    event.preventDefault()
    findControls.step(event.shiftKey ? -1 : 1)
    return
  }
  const { openDialog, groupDialog, collectionDialog, shortcutsOpen } = getState()
  if (event.key === 'Escape' && getState().findOpen && !typing(event.target) && !paletteOpen && !openDialog) {
    closeFind()
    return
  }
  if (mod || event.altKey || typing(event.target) || paletteOpen || openDialog || groupDialog || collectionDialog || shortcutsOpen || !workspace) return
  const key = event.key
  const active = workspace.active
  const bindings: Record<string, (() => unknown) | undefined> = {
    '/': () => {
      setState({ sidebarOpen: true })
      requestAnimationFrame(() => document.getElementById('sidebar-filter')?.focus())
    },
    // | splits the current document with the previous one, or closes the split.
    '|': () => {
      if (currentSplit(workspace)) return actions.unsplit()
      const open = new Set(workspace.tabs.map((tab) => tab.path))
      const previous = [...workspace.recentFiles, ...open].find((path) => open.has(path) && path !== active)
      if (active && previous) actions.split(previous, 'right')
    },
    '?': () => setState({ shortcutsOpen: true }),
    b: active && projectFor(active) ? () => recompile(projectFor(active)!.root) : undefined,
    '[': () => stepTab(-1),
    ']': () => stepTab(1),
    x: active ? () => actions.close(active) : undefined,
    s: active ? () => actions.view(!workspace.source) : undefined,
    t: () => actions.theme(resolveTheme(workspace.theme) === 'dark' ? 'light' : 'dark'),
    o: () => setState({ openDialog: 'open-file' }),
    c: active ? () => startComment(active, focusedArticle()) : undefined,
    p: active ? () => togglePin(workspace) : undefined,
    e: active
      ? () => (getState().editModes[active] ? closeEditor(active) : openEditor(active, 'edit'))
      : undefined,
    r: active && getState().editModes[active] ? () => closeEditor(active) : undefined,
  }
  const tab = /^[1-9]$/.test(key) ? (key === '9' ? workspace.tabs.at(-1) : workspace.tabs[Number(key) - 1]) : undefined
  const run = bindings[key] ?? (tab ? () => actions.focus(tab.path) : undefined)
  if (!run) return
  // Consume the key so it never lands in a field the shortcut focuses (the path dialog, the filter).
  event.preventDefault()
  run()
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : theme
}

export default function App() {
  const connection = useLeaf((s) => s.connection)
  const workspace = useLeaf((s) => s.workspace)
  const sidebarOpen = useLeaf((s) => s.sidebarOpen)
  const systemDark = useSyncExternalStore(
    (listener) => {
      darkQuery.addEventListener('change', listener)
      return () => darkQuery.removeEventListener('change', listener)
    },
    () => darkQuery.matches,
  )
  const preference = workspace?.theme ?? 'light'
  const theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  const active = workspace?.active ?? null

  useEffect(() => startSync(), [])
  // Closing or reloading the page with unsaved edits asks first.
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (Object.values(getState().drafts).some(isDirty)) event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
  }, [theme])
  useEffect(() => {
    document.title = active ? `${basename(active)} · Leaf` : 'Leaf'
  }, [active])

  if (connection === 'unauthenticated') {
    return (
      <div className="grid h-full place-items-center bg-paper p-8 text-center">
        <div className="max-w-sm">
          <LeafMark className="mx-auto mb-4 size-8 text-leaf" />
          <p className="font-medium text-ink">Open Leaf through its local service</p>
          <p className="mt-2 text-sm text-ink-muted">
            Run <code className="font-mono text-[12px]">leaf ui</code>; this page needs the token the service provides.
          </p>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full">
        {sidebarOpen && <Sidebar />}
        <main className="print-flow flex min-w-0 flex-1 flex-col">
          <TabStrip />
          {!workspace ? (
            <div className="flex-1 bg-paper" />
          ) : active ? (
            <Panes theme={theme} />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
      <CommandPalette />
      <OpenDialog />
      <ShortcutsDialog />
      <GroupDialog />
      <CollectionDialog />
      <DiffDialog />
      <Toaster theme={theme} position="bottom-right" />
    </TooltipProvider>
  )
}
