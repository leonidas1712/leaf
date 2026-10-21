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

/** Subsequence match with a bonus for hits in the file name and at word starts. */
function score(path: string, query: string) {
  const name = basename(path).toLowerCase()
  const haystack = path.toLowerCase()
  if (name.includes(query)) return 1000 - name.indexOf(query) - name.length / 100
  let position = -1
  let total = 0
  for (const char of query) {
    const next = haystack.indexOf(char, position + 1)
    if (next < 0) return -1
    total += next === position + 1 ? 3 : /[/._ -]/.test(haystack[next - 1] ?? '') ? 2 : 0
    position = next
  }
  return total - haystack.length / 200
}

export function CommandPalette() {
  const open = useLeaf((s) => s.paletteOpen)
  const workspace = useLeaf((s) => s.workspace)
  const entries = useLeaf((s) => s.entries)
  const sidebarOpen = useLeaf((s) => s.sidebarOpen)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const documents = useMemo(() => [...entries.keys()].filter((path) => TEXT_FILE.test(path)), [entries])
  const matches = useMemo(() => {
    if (!needle) return []
    return documents
      .map((path) => [path, score(path, needle)] as const)
      .filter(([, value]) => value >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([path]) => path)
  }, [documents, needle])

  if (!workspace) return null
  const tabs = workspace.tabs.filter((tab) => !needle || score(tab.path, needle) >= 0)
  const close = () => {
    setState({ paletteOpen: false })
    setQuery('')
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={(value) => (value ? setState({ paletteOpen: true }) : close())}
      title="Command palette"
      description="Switch tabs, open documents, and run commands"
      shouldFilter={false}
      className="top-[18%] translate-y-0 sm:max-w-[600px]"
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search documents, tabs and commands…" />
      <CommandList className="max-h-[min(460px,60vh)]">
        <CommandEmpty>No documents or commands match.</CommandEmpty>
        {tabs.length > 0 && (
          <CommandGroup heading="Open tabs">
            {tabs.map((tab) => (
              <CommandItem key={'tab:' + tab.path} value={'tab:' + tab.path} onSelect={run(() => actions.focus(tab.path))}>
                <FileText className={tab.path === workspace.active ? 'text-leaf' : undefined} />
                <span className="truncate">{basename(tab.path)}</span>
                <span className="ml-auto max-w-[45%] truncate text-[11.5px] text-ink-faint">{displayPath(tab.path)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {matches.length > 0 && (
          <CommandGroup heading="Documents">
            {matches.map((path) => (
              <CommandItem key={'doc:' + path} value={'doc:' + path} onSelect={run(() => actions.open(path))}>
                <FileText />
                <span className="truncate">{basename(path)}</span>
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
