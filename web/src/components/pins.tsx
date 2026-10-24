import { useState } from 'react'
import { FileText, Pin, X } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { REVEAL_LABEL, type Workspace } from '@/lib/api'
import { acceptDrop, carriesPath, draggedPath, startDrag } from '@/lib/dnd'
import { basename, displayPath } from '@/lib/paths'
import { actions, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'

/** Pin or unpin `path`, for any document menu. */
export function PinMenuItem({ path }: { path: string }) {
  const pinned = useLeaf((s) => !!s.workspace?.pins?.includes(path))
  return (
    <ContextMenuItem onSelect={() => (pinned ? actions.unpin(path) : actions.pin(path))}>
      {pinned ? 'Unpin' : 'Pin to sidebar'}
    </ContextMenuItem>
  )
}

/** Toggle the pin on the active document (the p shortcut and the palette). */
export function togglePin(workspace: Workspace) {
  const path = workspace.active
  if (!path) return
  return workspace.pins?.includes(path) ? actions.unpin(path) : actions.pin(path)
}

/** Accept a dragged document: `index` says where it lands; an existing pin moves there. */
function useDrop(index: (path: string) => number) {
  const [over, setOver] = useState(false)
  const enter = (event: React.DragEvent) => {
    if (!carriesPath(event)) return
    acceptDrop(event)
    event.stopPropagation()
    setOver(true)
  }
  return {
    over,
    handlers: {
      onDragEnter: enter,
      onDragOver: enter,
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        const path = draggedPath(event)
        if (path) actions.pin(path, index(path))
      },
    },
  }
}

function PinRow({ path, index, pins, active, missing }: { path: string; index: number; pins: string[]; active: boolean; missing: boolean }) {
  // Dropping on a row puts the document just above it. A pin moving down leaves a gap above,
  // so it lands one place earlier once removed.
  const { over, handlers } = useDrop((dropped) => {
    const from = pins.indexOf(dropped)
    return from >= 0 && from < index ? index - 1 : index
  })
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...handlers}
          className={cn(
            'group/pin relative flex h-7 items-center rounded-md transition-colors duration-100',
            active ? 'bg-leaf-soft' : 'hover:bg-accent',
            over && 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-leaf',
          )}
        >
          <button
            type="button"
            draggable
            onDragStart={(event) => startDrag(event, path)}
            onClick={() => actions.open(path)}
            title={missing ? 'File is missing or unavailable' : displayPath(path)}
            className={cn(
              'flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-left text-[13px]',
              active ? 'font-medium text-leaf-ink' : 'text-ink-soft hover:text-ink',
            )}
          >
            <FileText className={cn('size-3.5 shrink-0', active ? 'text-leaf' : 'text-ink-faint', missing && 'text-destructive')} />
            <span className={cn('truncate', missing && 'line-through decoration-ink-faint')}>{basename(path)}</span>
          </button>
          <button
            type="button"
            aria-label={`Unpin ${basename(path)}`}
            title="Unpin"
            onClick={() => actions.unpin(path)}
            className="mr-1 grid size-5 shrink-0 place-items-center rounded text-ink-faint opacity-0 transition-opacity group-hover/pin:opacity-100 hover:bg-paper hover:text-ink focus-visible:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => actions.open(path)}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.split(path, 'right')}>Open to the right</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.reveal(path)}>{REVEAL_LABEL}</ContextMenuItem>
        <ContextMenuItem onSelect={() => navigator.clipboard.writeText(path)}>Copy path</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={index === 0} onSelect={() => actions.pin(path, index - 1)}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={index === pins.length - 1} onSelect={() => actions.pin(path, index + 1)}>
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.unpin(path)}>Unpin</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Documents kept at hand, above collections: click to return, drag to pin or reorder. */
export function PinsSection({ workspace, query }: { workspace: Workspace; query: string }) {
  const entries = useLeaf((s) => s.entries)
  const pins = workspace.pins ?? []
  // Dropping on the heading or the empty space adds to the end.
  const { over, handlers } = useDrop((dropped) => pins.length - (pins.includes(dropped) ? 1 : 0))
  const shown = query ? pins.filter((path) => path.toLowerCase().includes(query.toLowerCase())) : pins
  if (query && !shown.length) return null
  return (
    <section className="mt-5 first:mt-2" {...handlers}>
      <div className={cn('mb-1 flex h-6 items-center rounded-md px-2', over && 'bg-leaf-soft ring-1 ring-leaf/60 ring-inset')}>
        <h2 className="text-[11px] font-medium text-ink-faint">Pinned</h2>
      </div>
      {shown.map((path) => (
        <PinRow
          key={path}
          path={path}
          index={pins.indexOf(path)}
          pins={pins}
          active={path === workspace.active}
          missing={!!entries.get(path)?.error}
        />
      ))}
      {!pins.length && (
        <p className="flex items-start gap-2 px-2 py-1.5 text-[12px] leading-relaxed text-ink-faint">
          <Pin className="mt-0.5 size-3.5 shrink-0" />
          Pin documents you come back to: right-click a tab, press p, or drag one here.
        </p>
      )}
    </section>
  )
}
