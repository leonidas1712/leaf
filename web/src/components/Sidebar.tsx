import { memo, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Clock,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FilePlus,
  PanelLeftClose,
  Plus,
  Search,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { REVEAL_LABEL, type Entry, type TabGroup, type Workspace } from '@/lib/api'
import { basename, displayPath } from '@/lib/paths'
import { actions, setState, DOCUMENT_FILE, toggleExpanded, useLeaf } from '@/lib/store'
import { buildTree, type TreeNode } from '@/lib/tree'
import { cn } from '@/lib/utils'
import { CollectionsSection } from './collections'
import { PinMenuItem, PinsSection } from './pins'
import { GroupMenuItems, groupStyle } from './groups'
import { LeafMark } from './LeafMark'
import { acceptDrop, carriesPath, draggedPath, startDrag } from '@/lib/dnd'

/** Projects first: each group with its tab count; closed groups wait, dimmed, to be reopened. */
function GroupRow({ group, workspace }: { group: TabGroup; workspace: Workspace }) {
  const [over, setOver] = useState(false)
  const members = workspace.tabs.filter((tab) => tab.group === group.id)
  const containsActive = members.some((tab) => tab.path === workspace.active)
  const count = group.closed ? (group.saved?.length ?? 0) : members.length
  const open = () => {
    if (group.closed) actions.groupOpen(group)
    else {
      if (group.collapsed) actions.groupUpdate(group, { collapsed: false })
      if (members[0] && !containsActive) actions.focus(members[0].path)
    }
  }
  const acceptPath = (event: React.DragEvent) => {
    if (!carriesPath(event)) return
    acceptDrop(event)
    setOver(true)
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          style={groupStyle(group.color)}
          onClick={open}
          title={group.closed ? `Reopen ${count} tabs` : `${count} open tabs · drop documents here to add them`}
          onDragEnter={acceptPath}
          onDragOver={acceptPath}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            const path = draggedPath(event)
            if (path && !members.some((tab) => tab.path === path)) actions.addToGroup(path, group)
          }}
          className={cn(
            'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-accent',
            containsActive ? 'font-medium text-ink' : 'text-ink-soft',
            group.closed && 'text-ink-muted',
            over && 'bg-[color-mix(in_oklch,var(--g)_18%,var(--chrome))] ring-1 ring-(--g) ring-inset',
          )}
        >
          <span
            className={cn(
              'size-2.5 shrink-0 rounded-full',
              group.closed ? 'border-[1.5px] border-(--g)' : 'bg-(--g)',
            )}
          />
          <span className="truncate">{group.name}</span>
          <span className="ml-auto text-[11px] font-normal text-ink-faint tabular-nums">
            {group.closed ? `closed · ${count}` : count}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <GroupMenuItems group={group} tabCount={members.length} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const ROW = 'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] transition-colors duration-100'

const Row = memo(function Row({
  node,
  depth,
  active,
  expanded,
  forceOpen,
}: {
  node: TreeNode
  depth: number
  active: string | null
  expanded: Set<string>
  forceOpen: boolean
}) {
  const indent = { paddingLeft: 8 + depth * 14 }
  if (!node.folder) {
    const selected = node.path === active
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            style={indent}
            title={displayPath(node.path)}
            onClick={() => actions.open(node.path)}
            draggable
            onDragStart={(event) => startDrag(event, node.path)}
            className={cn(ROW, selected ? 'bg-leaf-soft font-medium text-leaf-ink' : 'text-ink-soft hover:bg-accent hover:text-ink')}
          >
            <span className="w-3.5 shrink-0" />
            <FileText className={cn('size-3.5 shrink-0', selected ? 'text-leaf' : 'text-ink-faint')} />
            <span className="truncate">{node.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => actions.open(node.path)}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={() => actions.split(node.path, 'right')}>Open to the right</ContextMenuItem>
          <PinMenuItem path={node.path} />
          <ContextMenuItem onSelect={() => actions.reveal(node.path)}>{REVEAL_LABEL}</ContextMenuItem>
          <ContextMenuItem onSelect={() => navigator.clipboard.writeText(node.path)}>Copy path</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }
  const open = forceOpen || expanded.has(node.path)
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            style={indent}
            aria-expanded={open}
            onClick={() => toggleExpanded(node.path)}
            className={cn(ROW, 'text-ink-soft hover:bg-accent hover:text-ink')}
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-ink-faint transition-transform duration-150', open && 'rotate-90')} />
            {open ? <FolderOpen className="size-3.5 shrink-0 text-ink-faint" /> : <Folder className="size-3.5 shrink-0 text-ink-faint" />}
            <span className="truncate">{node.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => actions.reveal(node.path)}>{REVEAL_LABEL}</ContextMenuItem>
          <ContextMenuItem onSelect={() => navigator.clipboard.writeText(node.path)}>Copy path</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open &&
        node.children.map((child) => (
          <Row key={child.path} node={child} depth={depth + 1} active={active} expanded={expanded} forceOpen={forceOpen} />
        ))}
    </>
  )
})

function FolderSection({
  root,
  entries,
  query,
  active,
  expanded,
  missing,
  hint,
}: {
  root: string
  entries: Map<string, Entry>
  query: string
  active: string | null
  expanded: Set<string>
  missing?: string
  /** Where the folder lives: its parent folder. */
  hint?: string
}) {
  const tree = useMemo(() => buildTree(root, entries, query), [root, entries, query])
  const open = !!query || expanded.has(root)
  if (query && !tree.documents) return null
  return (
    <div className="mb-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggleExpanded(root)}
            title={displayPath(root)}
            className="group/root flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-accent"
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-ink-faint transition-transform duration-150', open && 'rotate-90')} />
            <span className="truncate">{tree.name}</span>
            {hint && <span className="min-w-0 shrink truncate text-[11px] font-normal text-ink-faint">{hint}</span>}
            {missing ? (
              <TriangleAlert className="ml-auto size-3.5 shrink-0 text-destructive" aria-label={missing} />
            ) : (
              <span className="ml-auto text-[11px] font-normal text-ink-faint tabular-nums">{tree.documents}</span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem onSelect={() => actions.reveal(root)}>{REVEAL_LABEL}</ContextMenuItem>
          <ContextMenuItem onSelect={() => navigator.clipboard.writeText(root)}>Copy path</ContextMenuItem>
          <ContextMenuItem onSelect={() => setState({ expanded: new Set([...expanded].filter((p) => p !== root && !p.startsWith(root + '/'))) })}>
            Collapse all
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => actions.removeFolder(root)}>
            Remove from sidebar
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {missing && open && <p className="py-1 pr-2 pl-8 text-[12px] text-ink-muted">Folder is unavailable. Restore it, then refresh.</p>}
      {open &&
        tree.children.map((child) => (
          <Row key={child.path} node={child} depth={1} active={active} expanded={expanded} forceOpen={!!query} />
        ))}
    </div>
  )
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mt-5 first:mt-2">
      <div className="mb-1 flex h-6 items-center justify-between px-2">
        <h2 className="text-[11px] font-medium text-ink-faint">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Sidebar() {
  const workspace = useLeaf((s) => s.workspace)
  const entries = useLeaf((s) => s.entries)
  const expanded = useLeaf((s) => s.expanded)
  const search = useLeaf((s) => s.search)
  const width = useLeaf((s) => s.sidebarWidth)
  const missing = useLeaf((s) => s.missing)
  const connection = useLeaf((s) => s.connection)
  const texProjects = useLeaf((s) => s.tex)
  const filter = useRef<HTMLInputElement>(null)
  const [resizing, setResizing] = useState(false)

  if (!workspace) return null
  const folders = workspace.folders
  // Each folder shows where it lives: its parent's name, or the parent's whole path when a same-named folder shares that name.
  const folderHints = new Map<string, string>()
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))
  for (const root of folders) {
    const shared = folders.filter((other) => basename(other) === basename(root) && basename(parent(other)) === basename(parent(root)))
    folderHints.set(root, shared.length > 1 ? displayPath(parent(root)) : basename(parent(root)) || '/')
  }
  const loose = workspace.files.filter(
    (path) => !folders.some((folder) => path.startsWith(folder + '/')) && (!search || path.toLowerCase().includes(search.toLowerCase())),
  )
  // Recently shown documents, open tabs included (switching among many tabs is when this helps most),
  // then recently added folders that are no longer in the sidebar.
  const openTabs = new Set(workspace.tabs.map((tab) => tab.path))
  const recent = [
    ...workspace.recentFiles.filter((path) => path !== workspace.active).slice(0, 8),
    ...workspace.recentFolders.filter((path) => !folders.includes(path)).slice(0, 3),
  ]
  const missingFor = (path: string) => missing.find((item) => item.path === path)?.error

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    setResizing(true)
    const onMove = (move: PointerEvent) =>
      setState({ sidebarWidth: Math.round(Math.min(600, Math.max(200, startWidth + move.clientX - startX))) })
    const onUp = () => {
      setResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const iconButton = (label: string, icon: React.ReactNode, onClick: () => void, shortcut?: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="size-7 text-ink-muted hover:text-ink">
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )

  return (
    <aside style={{ width }} className="print-hide relative flex h-full shrink-0 flex-col bg-chrome">
      <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
        <LeafMark className="size-[18px] text-leaf" />
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">Leaf</span>
        <div className="ml-auto flex items-center">
          {iconButton('Open document', <FilePlus className="size-4" />, () => setState({ openDialog: 'open-file' }), 'O')}
          {iconButton('Add folder', <FolderPlus className="size-4" />, () => setState({ openDialog: 'open-folder' }))}
          {iconButton('Hide sidebar', <PanelLeftClose className="size-4" />, () => setState({ sidebarOpen: false }), '⌘\\')}
        </div>
      </div>

      <div className="px-3 pt-1 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-rule bg-paper/70 px-2.5 text-ink-muted transition-colors focus-within:border-leaf/60 focus-within:bg-paper">
          <Search className="size-3.5 shrink-0" />
          <input
            ref={filter}
            id="sidebar-filter"
            value={search}
            onChange={(event) => setState({ search: event.target.value })}
            onKeyDown={(event) => event.key === 'Escape' && (setState({ search: '' }), filter.current?.blur())}
            placeholder="Filter documents"
            aria-label="Filter documents"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
          {!search && <Kbd className="h-[18px] text-[10px]">/</Kbd>}
        </label>
      </div>

      <nav aria-label="Library" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <PinsSection workspace={workspace} query={search} />
        {!search && <CollectionsSection workspace={workspace} />}
        {!search && (
          <Section
            title="Groups"
            action={
              <button
                type="button"
                aria-label="New group"
                title={workspace.active ? 'New group with the current tab' : 'New group'}
                onClick={() => setState({ groupDialog: { paths: workspace.active ? [workspace.active] : [] } })}
                className="grid size-5 place-items-center rounded text-ink-faint transition-colors hover:bg-accent hover:text-ink"
              >
                <Plus className="size-3.5" />
              </button>
            }
          >
            {workspace.groups?.length ? (
              workspace.groups.map((group) => <GroupRow key={group.id} group={group} workspace={workspace} />)
            ) : (
              <p className="px-2 text-[12px] leading-relaxed text-ink-faint">
                Group a project's tabs to set them aside and come back later.
              </p>
            )}
          </Section>
        )}
        {!search && recent.length > 0 && (
          <Section title="Recent">
            {recent.map((path) => {
              const folder = !DOCUMENT_FILE.test(path)
              const open = openTabs.has(path)
              return (
                <button
                  key={path}
                  type="button"
                  title={`${displayPath(path)}${folder ? '' : open ? ' · open tab' : ' · closed'}`}
                  onClick={() => (folder ? actions.openFolder(path) : actions.open(path))}
                  draggable={!folder}
                  onDragStart={(event) => !folder && startDrag(event, path)}
                  className={cn(
                    'flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-accent hover:text-ink',
                    open ? 'text-ink-soft' : 'text-ink-muted',
                  )}
                >
                  {folder ? (
                    <Folder className="size-3.5 shrink-0 text-ink-faint" />
                  ) : open ? (
                    <FileText className="size-3.5 shrink-0 text-ink-faint" />
                  ) : (
                    <Clock className="size-3.5 shrink-0 text-ink-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{basename(path)}</span>
                  {/* The folder takes at most 40% of the row, so the file name stays readable in a narrow sidebar. */}
                  <span className="max-w-[40%] shrink-0 truncate pl-2 text-[11px] text-ink-faint">
                    {texProjects.some((project) => project.pdf === path) ? 'live PDF' : basename(path.slice(0, path.lastIndexOf('/')))}
                  </span>
                </button>
              )
            })}
          </Section>
        )}
        {folders.length > 0 && (
          <Section title="Folders">
            {folders.map((root) => (
              <FolderSection
                key={root}
                hint={folderHints.get(root)}
                root={root}
                entries={entries}
                query={search}
                active={workspace.active}
                expanded={expanded}
                missing={missingFor(root)}
              />
            ))}
          </Section>
        )}

        {loose.length > 0 && (
          <Section title="Files">
            {loose.map((path) => {
              const selected = path === workspace.active
              return (
                <ContextMenu key={path}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      title={displayPath(path)}
                      onClick={() => actions.open(path)}
                      draggable
                      onDragStart={(event) => startDrag(event, path)}
                      className={cn(
                        'flex w-full flex-col rounded-md px-2 py-1 text-left transition-colors',
                        selected ? 'bg-leaf-soft' : 'hover:bg-accent',
                      )}
                    >
                      <span className={cn('flex items-center gap-1.5 text-[13px]', selected ? 'font-medium text-leaf-ink' : 'text-ink-soft')}>
                        <FileText className={cn('size-3.5 shrink-0', selected ? 'text-leaf' : 'text-ink-faint')} />
                        <span className="truncate">{basename(path)}</span>
                      </span>
                      <span className="truncate pl-5 text-[11px] text-ink-faint">{displayPath(path.slice(0, path.lastIndexOf('/')))}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => actions.open(path)}>Open</ContextMenuItem>
                    <PinMenuItem path={path} />
                    <ContextMenuItem onSelect={() => actions.reveal(path)}>{REVEAL_LABEL}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => navigator.clipboard.writeText(path)}>Copy path</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </Section>
        )}

        {!folders.length && !loose.length && (
          <p className="mx-2 mt-6 text-[12.5px] leading-relaxed text-ink-muted">
            Folders and files you open appear here. Ask an agent to run{' '}
            <code className="rounded bg-paper px-1 font-mono text-[11.5px] text-ink">leaf open PATH</code>.
          </p>
        )}
      </nav>

      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-rule px-4 text-[11.5px] text-ink-muted">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            connection === 'live' ? 'bg-leaf' : connection === 'connecting' ? 'animate-pulse bg-ink-faint' : 'bg-destructive',
          )}
        />
        <span className="min-w-0 truncate whitespace-nowrap">
          {connection === 'live' ? 'Saved · agents connected' : connection === 'connecting' ? 'Connecting…' : 'Offline · changes not saved'}
        </span>
        <button
          type="button"
          onClick={() => setState({ shortcutsOpen: true })}
          className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-ink"
        >
          Shortcuts
          <Kbd>?</Kbd>
        </button>
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={startResize}
        onDoubleClick={() => setState({ sidebarWidth: 280 })}
        className={cn(
          'absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors hover:after:bg-leaf/50',
          resizing && 'after:bg-leaf/70',
        )}
      />
    </aside>
  )
}
