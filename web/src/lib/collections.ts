/* Collections form a tree through `parent`; array order is sibling order. */
import type { Collection, GroupColor } from './api'

export function childrenOf(collections: Collection[], parent: string | null) {
  return collections.filter((c) => c.parent === parent)
}

/** "Atlas › Plans" — the names from the root down to this collection. */
export function trail(collections: Collection[], id: string): string[] {
  const names: string[] = []
  for (let c = collections.find((x) => x.id === id); c; c = collections.find((x) => x.id === c!.parent)) names.unshift(c.name)
  return names
}

/** True when `id` is `ancestor` or sits anywhere beneath it; moving there would make a cycle. */
export function within(collections: Collection[], id: string, ancestor: string) {
  for (let c = collections.find((x) => x.id === id); c; c = collections.find((x) => x.id === c!.parent))
    if (c.id === ancestor) return true
  return false
}

/** A collection's own colour, or the nearest ancestor's. */
export function colorOf(collections: Collection[], id: string): GroupColor | null {
  for (let c = collections.find((x) => x.id === id); c; c = collections.find((x) => x.id === c!.parent))
    if (c.color) return c.color
  return null
}

export function documentCount(collections: Collection[], id: string): number {
  const own = collections.find((c) => c.id === id)?.docs.length ?? 0
  return own + childrenOf(collections, id).reduce((sum, child) => sum + documentCount(collections, child.id), 0)
}
