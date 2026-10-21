import { useMemo, useState } from 'react'
import { BookOpen, Code2, Copy, FileText, FolderPlus, FilePlus, Layers, Moon, PanelLeft, RefreshCw, Sun, X } from 'lucide-react'
import { groupStyle } from './groups'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { basename, displayPath } from '@/lib/paths'
import { actions, getState, setState, TEXT_FILE, useLeaf } from '@/lib/store'

/**
 * Rank a path for a query: file-name substring beats path substring beats a subsequence of
 * the file name. Subsequences never span directories, so "second.md" can't match an unrelated
 * file whose folders happen to contain those letters in order.
 */
function score(path: string, query: string) {
  const name = basename(path).toLowerCase()
  if (name === query) return 3000
  if (name.startsWith(query)) return 2000 - name.length / 100
  if (name.includes(query)) return 1000 - name.indexOf(query) - name.length / 100
  const at = path.toLowerCase().indexOf(query)
  if (at >= 0) return 500 - at / 100
  let position = -1
  let total = 100
  for (const char of query) {
    const next = name.indexOf(char, position + 1)
    if (next < 0) return -1
    total += next === position + 1 ? 3 : /[._ -]/.test(name[next - 1] ?? '') ? 2 : 0
    position = next
  }
  return total - name.length / 100
}

export function CommandPalette() {
  const open = useLeaf((s) => s.paletteOpen)
  const workspace = useLeaf((s) => s.workspace)
  const entries = useLeaf((s) => s.entries)
  const sidebarOpen = useLeaf((s) => s.sidebarOpen)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const needle = query.trim().toLowerCase()

  // Open tabs and every granted document, ranked together so the best match leads.
  const matches = useMemo(() => {
    if (!needle || !workspace) return []
    const paths = new Set([...workspace.tabs.map((tab) => tab.path), ...[...entries.keys()].filter((path) => TEXT_FILE.test(path))])
    return [...paths]
      .map((path) => [path, score(path, needle)] as const)
      .filter(([, value]) => value >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([path]) => path)
  }, [entries, needle, workspace])

  if (!workspace) return null
  const openPaths = new Set(workspace.tabs.map((tab) => tab.path))
  const close = () => {
    setState({ paletteOpen: false })
    setQuery('')
    setSelected('')
  }
  const run = (work: () => unknown) => () => {
    close()
    work()
  }

  const commands = [
    { label: 'Open document…', icon: FilePlus, shortcut: 'O', run: () => setState({ openDialog: 'open-file' }) },
    { label: 'Add folder…', icon: FolderPlus, run: () => setState({ openDialog: 'open-folder' }) },
    workspace.theme === 'dark'
      ? { label: 'Switch to light theme', icon: Sun, shortcut: 'T', run: () => actions.theme('light') }
      : { label: 'Switch to dark theme', icon: Moon, shortcut: 'T', run: () => actions.theme('dark') },
    {
      label: workspace.active ? 'New group with current tab…' : 'New group…',
      icon: Layers,
      run: () => setState({ groupDialog: { paths: workspace.active ? [workspace.active] : [] } }),
    },
    workspace.source
      ? { label: 'Show formatted document', icon: BookOpen, shortcut: 'S', run: () => actions.view(false) }
      : { label: 'Show Markdown source', icon: Code2, shortcut: 'S', run: () => actions.view(true) },
    { label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar', icon: PanelLeft, shortcut: '⌘\\', run: () => setState({ sidebarOpen: !getState().sidebarOpen }) },
    ...(workspace.active
      ? [
          { label: 'Copy path of current document', icon: Copy, run: () => navigator.clipboard.writeText(workspace.active!) },
          { label: 'Close current tab', icon: X, shortcut: 'X', run: () => actions.close(workspace.active!) },
        ]
      : []),
    { label: 'Reload folders and documents', icon: RefreshCw, run: () => actions.refresh() },
  ].filter((command) => !needle || command.label.toLowerCase().includes(needle))

  const groups = (workspace.groups ?? []).filter((group) => !needle || group.name.toLowerCase().includes(needle))
  const openGroup = (id: string) => {
    const group = workspace.groups?.find((g) => g.id === id)
    if (!group) return
    if (group.closed) return actions.groupOpen(group)
    if (group.collapsed) actions.groupUpdate(group, { collapsed: false })
    const first = workspace.tabs.find((tab) => tab.group === id)
    if (first) actions.focus(first.path)
  }

  // cmdk can't rank results it doesn't filter, so selection follows the first ranked item.
  const first = needle
    ? matches[0]
      ? 'doc:' + matches[0]
      : groups[0]
        ? 'group:' + groups[0].id
        : commands[0] && 'cmd:' + commands[0].label
    : workspace.tabs[0] && 'doc:' + workspace.tabs[0].path
  const documents = needle ? matches : workspace.tabs.map((tab) => tab.path)

  return (
    <CommandDialog
      open={open}
      onOpenChange={(value) => (value ? setState({ paletteOpen: true }) : close())}
      title="Command palette"
      description="Switch tabs, open documents, and run commands"
      shouldFilter={false}
      value={selected || first || ''}
      onValueChange={setSelected}
      className="top-[18%] translate-y-0 sm:max-w-[600px]"
    >
      <CommandInput
        value={query}
        onValueChange={(value) => {
          setQuery(value)
          setSelected('')
        }}
        placeholder="Search documents, tabs and commands…"
      />
      <CommandList className="max-h-[min(460px,60vh)]">
        <CommandEmpty>No documents or commands match.</CommandEmpty>
        {documents.length > 0 && (
          <CommandGroup heading={needle ? 'Documents' : 'Open tabs'}>
            {documents.map((path) => (
              <CommandItem
                key={'doc:' + path}
                value={'doc:' + path}
                onSelect={run(() => (openPaths.has(path) ? actions.focus(path) : actions.open(path)))}
              >
                <FileText className={path === workspace.active ? 'text-leaf' : undefined} />
                <span className="truncate">{basename(path)}</span>
                {needle && openPaths.has(path) && (
                  <span className="shrink-0 rounded bg-accent px-1.5 text-[10.5px] text-ink-muted">open</span>
                )}
                <span className="ml-auto max-w-[50%] truncate text-[11.5px] text-ink-faint">{displayPath(path)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {groups.length > 0 && (
          <CommandGroup heading="Groups">
            {groups.map((group) => (
              <CommandItem key={'group:' + group.id} value={'group:' + group.id} onSelect={run(() => openGroup(group.id))}>
                <span style={groupStyle(group.color)} className="ml-1 mr-0.5 size-2.5 rounded-full bg-(--g)" />
                <span className="truncate">{group.name}</span>
                <span className="ml-auto text-[11.5px] text-ink-faint">
                  {group.closed ? `Reopen ${group.saved?.length ?? 0} tabs` : `${workspace.tabs.filter((t) => t.group === group.id).length} tabs`}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {commands.length > 0 && (
          <CommandGroup heading="Commands">
            {commands.map((command) => (
              <CommandItem key={command.label} value={'cmd:' + command.label} onSelect={run(command.run)}>
                <command.icon />
                {command.label}
                {command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
