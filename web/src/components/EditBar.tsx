import { Check, GitMerge, Loader2, TriangleAlert, Undo2, UserPen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { discardDraft, isDirty, mergeIncoming, saveDraft } from '@/lib/drafts'
import { AUTHOR, setState, useLeaf } from '@/lib/store'
import { countConflicts } from '@/lib/versions'
import { cn } from '@/lib/utils'
import { authorName } from './CommentCard'

/** Save state, conflicts, and what others are doing to this document while you edit it. */
export function EditBar({ path }: { path: string }) {
  const draft = useLeaf((s) => s.drafts[path])
  const presence = useLeaf((s) => s.workspace?.editing?.[path])
  if (!draft) return null
  const dirty = isDirty(draft)
  const conflicts = countConflicts(draft.text)
  const other = presence && presence.author !== AUTHOR ? presence : null

  return (
    <div className="print-hide sticky top-0 z-20 -mx-3 mb-4 grid gap-2 border-b border-rule bg-paper px-3 pt-2 pb-2">
      <div className="flex h-8 items-center gap-2 text-[12.5px]">
        <span
          className={cn(
            'flex items-center gap-1.5',
            conflicts ? 'text-destructive' : dirty ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {draft.saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : conflicts ? (
            <TriangleAlert className="size-3.5" />
          ) : dirty ? (
            <span className="size-2 rounded-full bg-[var(--g-yellow)]" />
          ) : (
            <Check className="size-3.5 text-leaf" />
          )}
          {draft.saving
            ? 'Saving…'
            : conflicts
              ? `${conflicts} conflict${conflicts > 1 ? 's' : ''} to resolve`
              : dirty
                ? 'Unsaved changes'
                : 'Saved to disk'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-[11.5px] text-ink-faint max-[900px]:hidden">
            <Kbd className="h-4 text-[10px]">Esc</Kbd> <Kbd className="h-4 text-[10px]">r</Kbd> to read
          </span>
          {dirty && (
            <Button size="xs" variant="ghost" onClick={() => discardDraft(path)} className="text-ink-muted">
              <Undo2 /> Discard
            </Button>
          )}
          <Button size="xs" disabled={!dirty || !!conflicts || draft.saving} onClick={() => saveDraft(path)}>
            Save <Kbd className="h-4 bg-transparent text-[10px] text-primary-foreground/80">⌘S</Kbd>
          </Button>
        </div>
      </div>

      {draft.incoming && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_oklch,var(--g-orange)_40%,var(--rule))] bg-[color-mix(in_oklch,var(--g-orange)_10%,var(--paper))] px-3 py-2 text-[12.5px] text-ink-soft">
          <GitMerge className="size-3.5 shrink-0 text-[var(--g-orange)]" />
          <span className="mr-auto">The file changed on disk while you were editing.</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setState({ diff: { path, title: 'Changes on disk since you started editing', before: draft.base, after: draft.incoming!.text } })}
          >
            View changes
          </Button>
          <Button size="xs" variant="outline" onClick={() => mergeIncoming(path)}>
            Merge into my edits
          </Button>
        </div>
      )}

      {other && (
        <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
          <UserPen className="size-3.5" />
          {authorName(other.author)} said it is editing this document. If you both change the same lines, Leaf asks
          you to choose when you save.
        </p>
      )}

      {conflicts > 0 && (
        <p className="text-[12px] text-ink-muted">
          Both you and someone else changed the highlighted lines. Pick <span className="text-ink">Keep yours</span>,{' '}
          <span className="text-ink">Keep on disk</span>, or <span className="text-ink">Keep both</span> for each, or edit
          them by hand, then save.
        </p>
      )}
    </div>
  )
}
