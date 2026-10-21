import { Check, Library, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Collection } from '@/lib/api'
import { colorOf, trail } from '@/lib/collections'
import { actions, setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { groupStyle } from './groups'

const NONE: Collection[] = []

/** File the current document into collections, or see where it is filed, from the title block. */
export function CollectionPicker({ path }: { path: string }) {
  const collections = useLeaf((s) => s.workspace?.collections ?? NONE)
  const containing = collections.filter((c) => c.docs.includes(path))

  // Depth-first order so nesting reads naturally in a flat list.
  const ordered: { collection: Collection; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const collection of collections.filter((c) => c.parent === parent)) {
      ordered.push({ collection, depth })
      walk(collection.id, depth + 1)
    }
  }
  walk(null, 0)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex max-w-56 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-ink',
            !containing.length && 'text-ink-faint',
          )}
        >
          <Library className="size-3.5 shrink-0" />
          <span className="truncate">
            {containing.length
              ? containing.map((c) => trail(collections, c.id).join(' › ')).join(', ')
              : 'Add to collection'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 bg-chrome-raised p-1.5 shadow-float">
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-ink-faint">Collections with this document</p>
        <div className="max-h-72 overflow-y-auto">
          {ordered.map(({ collection, depth }) => {
            const member = collection.docs.includes(path)
            const color = colorOf(collections, collection.id)
            return (
              <button
                key={collection.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={member}
                onClick={() => (member ? actions.collectionRemove(collection, [path]) : actions.collectionAdd(collection, [path]))}
                style={{ paddingLeft: 8 + depth * 14, ...(color ? groupStyle(color) : {}) }}
                className="flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] text-ink-soft transition-colors hover:bg-accent hover:text-ink"
              >
                <Library className={cn('size-3.5 shrink-0', color ? 'text-(--g)' : 'text-ink-faint')} />
                <span className="truncate">{collection.name}</span>
                {member && <Check className="ml-auto size-3.5 shrink-0 text-leaf" />}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => setState({ collectionDialog: { parent: null, paths: [path] } })}
          className="mt-1 flex h-8 w-full items-center gap-2 rounded-md border-t border-rule px-2 pt-1 text-left text-[13px] text-ink-muted transition-colors hover:bg-accent hover:text-ink"
        >
          <Plus className="size-3.5" /> New collection with this document…
        </button>
      </PopoverContent>
    </Popover>
  )
}
