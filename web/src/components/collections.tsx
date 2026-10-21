/*
 * Collections: Leaf-only folders that hold references to documents anywhere on disk. They nest,
 * accept drags from every other list, and open as a tab group. Nothing on disk ever moves.
 */
import { useEffect, useState } from 'react'
import { ChevronRight, FileText, FolderPlus, Library, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Collection, GroupColor, Workspace } from '@/lib/api'
import { childrenOf, colorOf, documentCount, trail, within } from '@/lib/collections'
import {
  carriesCollection,
  carriesPath,
  draggedCollection,
  draggedPath,
  startCollectionDrag,
  startDrag,
} from '@/lib/dnd'
import { basename, displayPath } from '@/lib/paths'
import { actions, getState, setState, toggleExpanded, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { groupStyle, Swatches } from './groups'

const key = (id: string) => 'collection:' + id

/** Shared drop handling: documents join the collection; collections nest inside it. */
function useDropTarget(onPath: (path: string) => void, onCollection?: (id: string) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        if (!carriesPath(event) && !(onCollection && carriesCollection(event))) return
        event.preventDefault()
        event.stopPropagation()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        const id = draggedCollection(event)
        const path = draggedPath(event)
        if (id && onCollection) onCollection(id)
        else if (path) onPath(path)
      },
    },
  }
}

function DocumentRow({ path, collection, depth, active, missing }: {
  path: string
  collection: Collection
  depth: number
  active: boolean
  missing: boolean
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          draggable
          onDragStart={(event) => startDrag(event, path)}
          onClick={() => actions.open(path)}
          title={displayPath(path)}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={cn(
            'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] transition-colors duration-100',
            active ? 'bg-leaf-soft font-medium text-leaf-ink' : 'text-ink-soft hover:bg-accent hover:text-ink',
          )}
        >
          <span className="w-3.5 shrink-0" />
          <FileText className={cn('size-3.5 shrink-0', active ? 'text-leaf' : 'text-ink-faint', missing && 'text-destructive')} />
          <span className={cn('truncate', missing && 'line-through decoration-ink-faint')}>{basename(path)}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => actions.open(path)}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => navigator.clipboard.writeText(path)}>Copy path</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.collectionRemove(collection, [path])}>Remove from {collection.name}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function CollectionNode({ collection, depth, workspace }: { collection: Collection; depth: number; workspace: Workspace }) {
  const expanded = useLeaf((s) => s.expanded)
  const entries = useLeaf((s) => s.entries)
  const all = workspace.collections ?? []
  const open = expanded.has(key(collection.id))
  const color = colorOf(all, collection.id)
  const count = documentCount(all, collection.id)
  const children = childrenOf(all, collection.id)
  const { over, handlers } = useDropTarget(
    (path) => {
      if (!collection.docs.includes(path)) actions.collectionAdd(collection, [path])
      toggleExpanded(key(collection.id), true)
    },
    (id) => {
      const moving = all.find((c) => c.id === id)
      if (moving && !within(all, collection.id, id) && moving.parent !== collection.id) actions.collectionMove(moving, collection.id)
    },
  )

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            draggable
            onDragStart={(event) => startCollectionDrag(event, collection.id)}
            onClick={() => toggleExpanded(key(collection.id))}
            aria-expanded={open}
            title={`${trail(all, collection.id).join(' › ')} · ${count} documents`}
            style={{ paddingLeft: 8 + depth * 14, ...(color ? groupStyle(color) : {}) }}
            {...handlers}
            className={cn(
              'group/collection flex h-7 w-full items-center gap-1.5 rounded-md pr-1 text-left text-[13px] transition-colors hover:bg-accent',
              depth === 0 ? 'font-medium text-ink' : 'text-ink-soft',
              over && 'bg-leaf-soft ring-1 ring-leaf/60 ring-inset',
            )}
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-ink-faint transition-transform duration-150', open && 'rotate-90')} />
            <Library className={cn('size-3.5 shrink-0', color ? 'text-(--g)' : 'text-ink-faint')} />
            <span className="truncate">{collection.name}</span>
            <span className="ml-auto text-[11px] font-normal text-ink-faint tabular-nums group-hover/collection:hidden">{count}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Open ${collection.name} as a tab group`}
              title="Open as a tab group"
              onClick={(event) => {
                event.stopPropagation()
                actions.collectionOpen(collection)
              }}
              className="ml-auto hidden rounded px-1.5 py-px text-[11px] font-normal text-ink-muted hover:bg-paper hover:text-ink group-hover/collection:block"
            >
              Open
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuItem disabled={!count} onSelect={() => actions.collectionOpen(collection)}>
            Open {count} documents as a group
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setState({ openDialog: { collection: collection.id } })}>Add document by path…</ContextMenuItem>
          {workspace.active && !collection.docs.includes(workspace.active) && (
            <ContextMenuItem onSelect={() => actions.collectionAdd(collection, [workspace.active!])}>
              Add current document
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => setState({ collectionDialog: { parent: collection.id } })}>New collection inside…</ContextMenuItem>
          <ContextMenuItem onSelect={() => setState({ collectionDialog: { collection } })}>Rename or recolour…</ContextMenuItem>
          {collection.parent && (
            <ContextMenuItem onSelect={() => actions.collectionMove(collection, null)}>Move to top level</ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => actions.collectionDelete(collection)}>
            Delete collection (documents stay on disk)
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && (
        <>
          {children.map((child) => (
            <CollectionNode key={child.id} collection={child} depth={depth + 1} workspace={workspace} />
          ))}
          {collection.docs.map((path) => (
            <DocumentRow
              key={path}
              path={path}
              collection={collection}
              depth={depth + 1}
              active={path === workspace.active}
              missing={!!entries.get(path)?.error}
            />
          ))}
          {!children.length && !collection.docs.length && (
            <p style={{ paddingLeft: 30 + depth * 14 }} className="py-1 pr-2 text-[12px] text-ink-faint">
              Drag documents here
            </p>
          )}
        </>
      )}
    </div>
  )
}

export function CollectionsSection({ workspace }: { workspace: Workspace }) {
  const collections = workspace.collections ?? []
  const { over, handlers } = useDropTarget(
    // A document dropped on the heading starts a new collection with it.
    (path) => setState({ collectionDialog: { parent: null, paths: [path] } }),
    (id) => {
      const moving = collections.find((c) => c.id === id)
      if (moving?.parent) actions.collectionMove(moving, null)
    },
  )
  return (
    <section className="mt-5 first:mt-2">
      <div
        {...handlers}
        className={cn('mb-1 flex h-6 items-center justify-between rounded-md px-2', over && 'bg-leaf-soft ring-1 ring-leaf/60 ring-inset')}
      >
        <h2 className="text-[11px] font-medium text-ink-faint">Collections</h2>
        <button
          type="button"
          aria-label="New collection"
          title="New collection"
          onClick={() => setState({ collectionDialog: { parent: null } })}
          className="grid size-5 place-items-center rounded text-ink-faint transition-colors hover:bg-accent hover:text-ink"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {childrenOf(collections, null).map((collection) => (
        <CollectionNode key={collection.id} collection={collection} depth={0} workspace={workspace} />
      ))}
      {!collections.length && (
        <button
          type="button"
          onClick={() => setState({ collectionDialog: { parent: null } })}
          {...handlers}
          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] leading-relaxed text-ink-faint transition-colors hover:bg-accent hover:text-ink-muted"
        >
          <FolderPlus className="mt-0.5 size-3.5 shrink-0" />
          Collect documents from any folder into projects. Drag files here; nothing on disk moves.
        </button>
      )}
    </section>
  )
}

export function CollectionDialog() {
  const dialog = useLeaf((s) => s.collectionDialog)
  const collections = useLeaf((s) => s.workspace?.collections)
  const [name, setName] = useState('')
  const [color, setColor] = useState<GroupColor | null>(null)
  const [error, setError] = useState('')
  const editing = dialog && 'collection' in dialog ? dialog.collection : null
  const parent = dialog && 'parent' in dialog ? dialog.parent : (editing?.parent ?? null)

  useEffect(() => {
    if (!dialog) return
    setName(editing?.name ?? '')
    setColor(editing?.color ?? null)
    setError('')
  }, [dialog, editing])

  const close = () => setState({ collectionDialog: null })
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || !dialog) return
    const siblings = childrenOf(collections ?? [], parent)
    if (siblings.some((c) => c.name === trimmed && c.id !== editing?.id)) {
      setError('A collection here already uses this name.')
      return
    }
    const failure = editing
      ? await actions.collectionUpdate(editing, { name: trimmed, color })
      : await actions.collectionCreate(trimmed, parent, color, 'paths' in dialog ? (dialog.paths ?? []) : [])
    if (failure) setError(failure)
    else {
      if (parent) setState({ expanded: new Set([...getState().expanded, key(parent)]) })
      close()
    }
  }

  const where = parent ? trail(collections ?? [], parent).join(' › ') : null

  return (
    <Dialog open={!!dialog} onOpenChange={(value) => !value && close()}>
      <DialogContent className="top-[22%] translate-y-0 bg-chrome-raised shadow-float sm:max-w-[420px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-[15px]">{editing ? 'Edit collection' : where ? `New collection in ${where}` : 'New collection'}</DialogTitle>
            <DialogDescription className="text-[13px]">
              A collection points at documents wherever they live. Removing one never touches the files.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project or topic"
            aria-label="Collection name"
            aria-invalid={!!error}
            className="h-10 bg-paper text-[14px]"
          />
          <div className="flex items-center gap-3">
            <Swatches value={color ?? 'grey'} onChange={setColor} />
            {color && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setColor(null)} className="text-ink-muted">
                No colour
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="-mt-1 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
