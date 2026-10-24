import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Command, FileText, PanelLeft, PanelRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { REVEAL_LABEL } from '@/lib/api'
import { displayPath, tabLabels } from '@/lib/paths'
import { closeEditor, isDirty, openEditor } from '@/lib/drafts'
import { actions, currentSplit, setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { PinMenuItem } from './pins'
import { GroupMenuItems, groupStyle } from './groups'
import { ReaderSettings } from './ReaderSettings'
import { acceptDrop, carriesPath, draggedFromTab, draggedPath, startDrag } from '@/lib/dnd'

export function TabStrip() {
  const workspace = useLeaf((s) => s.workspace)
  const entries = useLeaf((s) => s.entries)
  const sidebarOpen = useLeaf((s) => s.sidebarOpen)
  const outlineOpen = useLeaf((s) => s.outlineOpen)
  const editModes = useLeaf((s) => s.editModes)
  const drafts = useLeaf((s) => s.drafts)
  const tabs = workspace?.tabs ?? []
  const active = workspace?.active ?? null
  const split = workspace ? currentSplit(workspace) : null
  const readOnly = !!(active && workspace?.sources?.[active])
  const labels = useMemo(() => tabLabels(tabs.map((tab) => tab.path)), [tabs])
  const strip = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [active])

  const groups = workspace?.groups ?? []
  const openComments = new Map<string, number>()
  for (const comment of workspace?.comments ?? [])
    if (comment.status !== 'resolved') openComments.set(comment.path, (openComments.get(comment.path) ?? 0) + 1)
  const groupOf = (id?: string | null) => (id ? groups.find((g) => g.id === id) : undefined)

  /** Accept a Leaf document drag on enter and over; `key` names the highlighted target. */
  const acceptAs = (event: React.DragEvent, key?: string) => {
    if (!carriesPath(event)) return
    acceptDrop(event)
    if (key) setDropTarget(key)
  }

  // Dropping on a tab takes its slot and joins its group, as in Chrome. A document dragged
  // from the sidebar opens beside it, inside the same group.
  const dropOnTab = (event: React.DragEvent, target: string) => {
    const path = draggedPath(event)
    if (!path || path === target) return
    const index = tabs.findIndex((t) => t.path === target)
    const group = tabs[index].group ?? null
    if (draggedFromTab(event)) actions.moveTab(path, index, group)
    else actions.open(path, { group: group ?? undefined })
  }

  const move = (path: string, delta: number) => {
    const index = tabs.findIndex((t) => t.path === path) + delta
    if (index >= 0 && index < tabs.length) actions.moveTab(path, index)
  }

  const closeOthers = async (keep: string) => {
    for (const tab of tabs) if (tab.path !== keep) await actions.close(tab.path)
  }

  const icon = (label: string, child: React.ReactNode, onClick: () => void, shortcut?: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="text-ink-muted hover:text-ink">
          {child}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )

  return (
    <header className="print-hide flex h-11 shrink-0 items-end gap-1 bg-chrome pr-2">
      {!sidebarOpen && (
        <div className="mb-1.5 ml-2 self-center">
          {icon('Show sidebar', <PanelLeft />, () => setState({ sidebarOpen: true }), '⌘\\')}
        </div>
      )}
      <div
        ref={strip}
        role="tablist"
        aria-label="Open documents"
        className={cn(
          'flex h-full min-w-0 flex-1 items-end overflow-x-auto pl-2 [scrollbar-width:none]',
          dropTarget === 'strip' && 'bg-leaf-soft/40',
        )}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) strip.current!.scrollLeft += event.deltaY
        }}
        onDragEnter={(event) => acceptAs(event, event.target === event.currentTarget ? 'strip' : undefined)}
        onDragOver={(event) => acceptAs(event, event.target === event.currentTarget ? 'strip' : undefined)}
        onDragLeave={(event) => event.target === event.currentTarget && setDropTarget(null)}
        onDrop={(event) => {
          // Empty strip: open an outside document as a new ungrouped tab, or move a tab to the end.
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          setDropTarget(null)
          const path = draggedPath(event)
          if (!path) return
          if (draggedFromTab(event)) actions.moveTab(path, tabs.length - 1, null)
          else actions.open(path)
        }}
      >
        {tabs.map((tab, index) => {
          const selected = tab.path === active
          // The document in the split's other pane: shown, but not where tabs and shortcuts act.
          const beside = !selected && !!split?.panes.includes(tab.path)
          const missing = entries.get(tab.path)?.error
          const previousSelected = tabs[index - 1]?.path === active
          const group = groupOf(tab.group)
          const startsGroup = group && tabs[index - 1]?.group !== group.id
          const members = group ? tabs.filter((t) => t.group === group.id) : []
          // A collapsed group still shows the tab being read, so the reader never loses its place.
          const hidden = group?.collapsed && !selected
          return (
            <Fragment key={tab.path}>
              {startsGroup && group && (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      style={groupStyle(group.color)}
                      aria-expanded={!group.collapsed}
                      title={`${group.name} · ${members.length} tabs`}
                      onClick={() => actions.groupUpdate(group, { collapsed: !group.collapsed })}
                      onDragEnter={(event) => acceptAs(event, 'group:' + group.id)}
                      onDragOver={(event) => acceptAs(event, 'group:' + group.id)}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(event) => {
                        event.preventDefault()
                        setDropTarget(null)
                        const path = draggedPath(event)
                        if (path && tabs.find((t) => t.path === path)?.group !== group.id) actions.addToGroup(path, group)
                      }}
                      className={cn(
                        'mx-1 mb-[5px] flex h-6 max-w-40 shrink-0 items-center gap-1.5 self-end rounded-md px-2 text-[12px] font-semibold transition-colors',
                        'bg-[color-mix(in_oklch,var(--g)_20%,var(--chrome))] text-[color-mix(in_oklch,var(--g)_75%,var(--ink))] hover:bg-[color-mix(in_oklch,var(--g)_30%,var(--chrome))]',
                        dropTarget === 'group:' + group.id && 'ring-2 ring-(--g)',
                      )}
                    >
                      <span className="truncate">{group.name}</span>
                      {group.collapsed && <span className="font-normal tabular-nums opacity-75">{members.length}</span>}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-60">
                    <GroupMenuItems group={group} tabCount={members.length} />
                  </ContextMenuContent>
                </ContextMenu>
              )}
              {!hidden && (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div
                      data-active={selected}
                      draggable
                      style={group ? groupStyle(group.color) : undefined}
                      onDragStart={(event) => {
                        setDragging(tab.path)
                        startDrag(event, tab.path, true)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropTarget(null)
                      }}
                      onDragEnter={(event) => acceptAs(event, tab.path)}
                      onDragOver={(event) => acceptAs(event, tab.path)}
                      onDrop={(event) => {
                        event.preventDefault()
                        dropOnTab(event, tab.path)
                        setDropTarget(null)
                      }}
                      onAuxClick={(event) => event.button === 1 && actions.close(tab.path)}
                      className={cn(
                        'group/tab relative flex h-[34px] max-w-56 min-w-28 shrink-0 items-center rounded-t-[9px] transition-colors duration-150',
                        selected
                          ? 'z-10 bg-paper text-ink'
                          : beside
                            ? 'bg-paper/55 text-ink hover:bg-paper/80'
                            : 'text-ink-muted hover:bg-accent/70 hover:text-ink',
                        dragging === tab.path && 'opacity-40',
                        dropTarget === tab.path && dragging !== tab.path && 'ring-1 ring-leaf/50 ring-inset',
                        // Hairline separators between resting tabs, hidden next to the selected one.
                        !selected && !beside && index > 0 && !previousSelected && !startsGroup &&
                          'before:absolute before:top-2 before:bottom-2 before:left-0 before:w-px before:bg-rule-strong',
                        // Group membership: a coloured rule under resting tabs, over the selected one.
                        group &&
                          (selected
                            ? 'after:absolute after:inset-x-2 after:top-0 after:h-0.5 after:rounded-full after:bg-(--g)'
                            : 'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-(--g)'),
                      )}
                    >
                      <button
                        role="tab"
                        aria-selected={selected}
                        title={displayPath(tab.path) + (group ? ` · ${group.name}` : '') + (beside ? ' · in the other pane' : '')}
                        onClick={() => actions.focus(tab.path)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-leaf/60 focus-visible:ring-inset"
                      >
                        <FileText className={cn('size-3.5 shrink-0', selected || beside ? 'text-leaf' : 'text-ink-faint', missing && 'text-destructive')} />
                        <span className={cn('truncate', missing && 'line-through decoration-ink-faint')}>{labels.get(tab.path)}</span>
                        {isDirty(drafts[tab.path]) && (
                          <span title="Unsaved changes" className="size-2 shrink-0 rounded-full bg-[var(--g-yellow)]" />
                        )}
                        {openComments.get(tab.path) && (
                          <span
                            title={`${openComments.get(tab.path)} open comments`}
                            className="shrink-0 rounded-full bg-[color-mix(in_oklch,var(--g-yellow)_30%,transparent)] px-1.5 text-[10.5px] leading-4 font-semibold text-ink tabular-nums"
                          >
                            {openComments.get(tab.path)}
                          </span>
                        )}
                      </button>
                      <button
                        aria-label={`Close ${labels.get(tab.path)}`}
                        onClick={() => actions.close(tab.path)}
                        className={cn(
                          'mr-1.5 grid size-5 shrink-0 place-items-center rounded-md text-ink-faint transition hover:bg-accent hover:text-ink',
                          selected ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100',
                        )}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-56">
                    <PinMenuItem path={tab.path} />
                    <ContextMenuItem onSelect={() => actions.reveal(tab.path)}>{REVEAL_LABEL}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => navigator.clipboard.writeText(tab.path)}>Copy path</ContextMenuItem>
                    <ContextMenuSeparator />
                    {(['right', 'left', 'down', 'up'] as const).map((side) => (
                      <ContextMenuItem key={side} disabled={tabs.length < 2} onSelect={() => actions.split(tab.path, side)}>
                        Split {side}
                      </ContextMenuItem>
                    ))}
                    {split?.panes.includes(tab.path) && (
                      <ContextMenuItem onSelect={() => actions.unsplit(tab.path)}>Close split, keep this</ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setState({ groupDialog: { paths: [tab.path] } })}>Add to new group…</ContextMenuItem>
                    {groups.some((g) => !g.closed && g.id !== tab.group) && (
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>Add to group</ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
                          {groups
                            .filter((g) => !g.closed && g.id !== tab.group)
                            .map((g) => (
                              <ContextMenuItem key={g.id} style={groupStyle(g.color)} onSelect={() => actions.addToGroup(tab.path, g)}>
                                <span className="size-2 rounded-full bg-(--g)" />
                                {g.name}
                              </ContextMenuItem>
                            ))}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    )}
                    {group && <ContextMenuItem onSelect={() => actions.ungroup([tab.path])}>Remove from {group.name}</ContextMenuItem>}
                    <ContextMenuSeparator />
                    <ContextMenuItem disabled={index === 0} onSelect={() => move(tab.path, -1)}>
                      Move left
                    </ContextMenuItem>
                    <ContextMenuItem disabled={index === tabs.length - 1} onSelect={() => move(tab.path, 1)}>
                      Move right
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => actions.close(tab.path)}>
                      Close<ContextMenuShortcut>X</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem disabled={tabs.length < 2} onSelect={() => closeOthers(tab.path)}>
                      Close other tabs
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )}
            </Fragment>
          )
        })}
      </div>
      {workspace && (
        <div className="mb-1.5 flex shrink-0 items-center gap-1 self-center pl-2">
          {active && (
            <ToggleGroup
              type="single"
              size="sm"
              value={editModes[active] ?? 'read'}
              onValueChange={(value) => {
                if (value === 'read') closeEditor(active)
                else if (value === 'edit' || value === 'split') openEditor(active, value)
              }}
              className="h-7 rounded-lg bg-accent/60 p-0.5"
              aria-label="Document mode"
            >
              {(
                [
                  ['read', 'Read', 'Read the rendered document'],
                  ['edit', 'Edit', 'Edit the file (e)'],
                  ['split', 'Split', 'Edit beside a live preview'],
                ] as const
              ).map(([value, label, title]) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  title={readOnly && value !== 'read' ? 'Board documents are read-only in Leaf' : title}
                  disabled={readOnly && value !== 'read'}
                  className="h-6 rounded-md px-2.5 text-[12px] text-ink-muted data-[state=on]:bg-paper data-[state=on]:text-ink data-[state=on]:shadow-xs dark:data-[state=on]:bg-rule-strong"
                >
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <ReaderSettings />
          {active && icon(outlineOpen ? 'Hide outline' : 'Show outline', <PanelRight />, () => setState({ outlineOpen: !outlineOpen }), '⌘.')}
          {icon('Command palette', <Command />, () => setState({ paletteOpen: true }), '⌘K')}
        </div>
      )}
    </header>
  )
}
