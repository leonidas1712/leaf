import { useEffect, useSyncExternalStore } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CollectionDialog } from '@/components/collections'
import { CommandPalette } from '@/components/CommandPalette'
import { DocumentView } from '@/components/DocumentView'
import { EmptyState } from '@/components/EmptyState'
import { GroupDialog } from '@/components/groups'
import { LeafMark } from '@/components/LeafMark'
import { OpenDialog } from '@/components/OpenDialog'
import { Sidebar } from '@/components/Sidebar'
import { TabStrip } from '@/components/TabStrip'
import type { Theme } from '@/lib/api'
import { basename } from '@/lib/paths'
import { actions, DEFAULT_READER, getState, setState, startSync, stepTab, useLeaf } from '@/lib/store'

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
  const { openDialog, groupDialog, collectionDialog } = getState()
  if (mod || event.altKey || typing(event.target) || paletteOpen || openDialog || groupDialog || collectionDialog || !workspace) return
  const key = event.key
  const active = workspace.active
  const bindings: Record<string, (() => unknown) | undefined> = {
    '/': () => {
      setState({ sidebarOpen: true })
      requestAnimationFrame(() => document.getElementById('sidebar-filter')?.focus())
    },
    '[': () => stepTab(-1),
    ']': () => stepTab(1),
    x: active ? () => actions.close(active) : undefined,
    s: active ? () => actions.view(!workspace.source) : undefined,
    t: () => actions.theme(resolveTheme(workspace.theme) === 'dark' ? 'light' : 'dark'),
    o: () => setState({ openDialog: 'open-file' }),
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
  const entries = useLeaf((s) => s.entries)
  const sidebarOpen = useLeaf((s) => s.sidebarOpen)
  const stamps = useLeaf((s) => s.stamps)
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
            <DocumentView
              path={active}
              entry={entries.get(active)}
              source={workspace.source}
              theme={theme}
              entries={entries}
              stamp={stamps[active]}
              prefs={workspace.reader ?? DEFAULT_READER}
            />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
      <CommandPalette />
      <OpenDialog />
      <GroupDialog />
      <CollectionDialog />
      <Toaster theme={theme} position="bottom-right" />
    </TooltipProvider>
  )
}
