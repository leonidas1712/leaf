import { useEffect, useRef, useState } from 'react'
import { Check, CircleDot, Copy, Loader, MoreHorizontal, Pencil, RotateCcw, TextCursorInput, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Comment, CommentReply } from '@/lib/api'
import { selectionAnchor } from '@/lib/anchors'
import { actions, AUTHOR, setState } from '@/lib/store'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const AVATAR_COLORS = ['--g-purple', '--g-blue', '--g-orange', '--g-pink', '--g-cyan', '--g-red']

export function authorName(author: string) {
  return author === AUTHOR ? 'You' : author.charAt(0).toUpperCase() + author.slice(1)
}

function Avatar({ author }: { author: string }) {
  const color = author === AUTHOR ? '--leaf' : AVATAR_COLORS[[...author].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AVATAR_COLORS.length]
  return (
    <span
      aria-hidden
      style={{ background: `var(${color})` }}
      className="grid size-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold text-paper"
    >
      {authorName(author).charAt(0)}
    </span>
  )
}

/** "22:16" today, "21 Oct, 22:16" otherwise; the full timestamp sits in the tooltip. */
function When({ at }: { at?: string }) {
  if (!at) return null
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const label = today ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
  return (
    <time dateTime={at} title={date.toLocaleString()} className="text-[11px] text-ink-faint tabular-nums">
      {label}
    </time>
  )
}

/** Plain-text comment body; `code` spans get the code style, everything else stays literal. */
function Body({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('text-[13px] leading-relaxed whitespace-pre-wrap text-ink-soft', className)}>
      {text.split(/(`[^`\n]+`)/).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={i} className="rounded bg-code px-1 font-mono text-[12px] text-ink">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </p>
  )
}

/** Shared textarea: ⌘↵ submits, Esc cancels. */
export function Composer({
  initial = '',
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = true,
  compact = false,
}: {
  initial?: string
  placeholder: string
  submitLabel: string
  onSubmit: (body: string) => Promise<unknown> | unknown
  onCancel?: () => void
  autoFocus?: boolean
  compact?: boolean
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!autoFocus) return
    const node = field.current
    // The card may not be positioned yet; never let focusing it scroll the document.
    node?.focus({ preventScroll: true })
    node?.setSelectionRange(node.value.length, node.value.length)
  }, [autoFocus])

  const submit = async () => {
    const body = value.trim()
    if (!body || busy) return
    setBusy(true)
    const failed = await onSubmit(body)
    setBusy(false)
    if (!failed) setValue('')
  }

  return (
    <div className="grid gap-2" onClick={(event) => event.stopPropagation()}>
      <textarea
        ref={field}
        value={value}
        rows={compact && !value ? 1 : 3}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel?.()
          }
        }}
        placeholder={placeholder}
        className="field-sizing-content max-h-60 min-h-8 w-full resize-none rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-leaf/60"
      />
      {(value.trim() || !compact) && (
        <div className="flex items-center justify-end gap-1.5">
          <span className="mr-auto text-[11px] text-ink-faint">⌘↵</span>
          {onCancel && (
            <Button size="xs" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="xs" disabled={!value.trim() || busy} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  )
}

function StatusEntry({ entry }: { entry: CommentReply }) {
  const verb = entry.status === 'resolved' ? 'resolved' : entry.status === 'working' ? 'started working' : 'reopened'
  const Icon = entry.status === 'resolved' ? Check : entry.status === 'working' ? Loader : RotateCcw
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-muted">
        <Icon className="size-3.5 shrink-0 text-ink-faint" />
        <span>
          <span className="font-medium text-ink-soft">{authorName(entry.author)}</span> {verb}
        </span>
        <When at={entry.created} />
      </div>
      {entry.body && <Body text={entry.body} className="pl-5" />}
    </div>
  )
}

function Entry({ comment, entry, first }: { comment: Comment; entry: CommentReply; first: boolean }) {
  const [editing, setEditing] = useState(false)
  if (entry.status) return <StatusEntry entry={entry} />
  const mine = entry.author === AUTHOR
  return (
    <div className="group/entry grid gap-1">
      <div className="flex items-center gap-2">
        <Avatar author={entry.author} />
        <span className="text-[12.5px] font-semibold text-ink">{authorName(entry.author)}</span>
        <When at={entry.created} />
        {entry.edited && <span className="text-[11px] text-ink-faint">· edited</span>}
        {mine && !editing && !first && (
          <span className="ml-auto flex opacity-0 transition-opacity group-hover/entry:opacity-100">
            <button
              type="button"
              aria-label="Edit reply"
              onClick={(event) => {
                event.stopPropagation()
                setEditing(true)
              }}
              className="grid size-6 place-items-center rounded text-ink-faint hover:bg-accent hover:text-ink"
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              aria-label="Delete reply"
              onClick={(event) => {
                event.stopPropagation()
                actions.commentDelete(comment, entry.id)
              }}
              className="grid size-6 place-items-center rounded text-ink-faint hover:bg-accent hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          initial={entry.body}
          placeholder="Edit reply"
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const failed = await actions.commentEdit(comment, body, entry.id)
            if (!failed) setEditing(false)
            return failed
          }}
        />
      ) : (
        <Body text={entry.body} className="pl-7" />
      )}
    </div>
  )
}

export type Placement = 'attached' | 'moved' | 'ambiguous' | 'detached' | 'document'

const PLACEMENT_NOTE: Partial<Record<Placement, string>> = {
  moved: 'The commented text has changed',
  ambiguous: 'This text now appears more than once; select the right one and attach',
  detached: 'This text is no longer in the document',
}

/**
 * One comment thread: the first message, then every reply and status change in order, so the
 * whole conversation with an agent stays readable. Active threads show the reply box.
 */
export function CommentCard({
  comment,
  placement,
  active,
}: {
  comment: Comment
  placement: Placement
  active: boolean
}) {
  const [editing, setEditing] = useState(false)
  const resolved = comment.status === 'resolved'
  const working = comment.status === 'working'
  const first: CommentReply = { id: '', author: comment.author, body: comment.body, created: comment.created, edited: comment.edited }

  return (
    <article
      onClick={() => setState({ activeComment: comment.id })}
      aria-label={`Comment by ${authorName(comment.author)}`}
      className={cn(
        'group/card grid cursor-default gap-2.5 rounded-xl border bg-chrome-raised p-3 transition-[box-shadow,border-color,opacity] duration-150',
        active ? 'border-rule-strong shadow-float' : 'border-rule hover:border-rule-strong',
        resolved && !active && 'opacity-70',
      )}
    >
      {PLACEMENT_NOTE[placement] && comment.anchor && (
        <div className="grid gap-1 rounded-md bg-accent/60 px-2 py-1.5">
          <span className="flex items-center gap-1 text-[11px] font-medium text-ink-muted">
            <TriangleAlert className="size-3" />
            {PLACEMENT_NOTE[placement]}
          </span>
          <q className="line-clamp-3 text-[12px] text-ink-faint italic">{comment.anchor.quote}</q>
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <Composer
              initial={comment.body}
              placeholder="Edit comment"
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                const failed = await actions.commentEdit(comment, body)
                if (!failed) setEditing(false)
                return failed
              }}
            />
          ) : (
            <Entry comment={comment} entry={first} first />
          )}
        </div>
        <div className="-mt-0.5 -mr-1 flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={resolved ? 'Reopen' : 'Resolve'}
                onClick={(event) => {
                  event.stopPropagation()
                  actions.commentStatus(comment, resolved ? 'open' : 'resolved')
                }}
                className={cn(
                  'grid size-7 place-items-center rounded-md transition-colors',
                  resolved ? 'text-leaf hover:bg-accent' : 'text-ink-faint hover:bg-accent hover:text-leaf',
                )}
              >
                {resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{resolved ? 'Reopen' : 'Resolve'}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Comment actions"
                onClick={(event) => event.stopPropagation()}
                className="grid size-7 place-items-center rounded-md text-ink-faint transition-colors hover:bg-accent hover:text-ink"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {comment.author === AUTHOR && (
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
              )}
              {comment.status !== 'open' && (
                <DropdownMenuItem onSelect={() => actions.commentStatus(comment, 'open')}>
                  <CircleDot /> Mark open
                </DropdownMenuItem>
              )}
              {comment.anchor && placement !== 'attached' && (
                <DropdownMenuItem
                  onSelect={() => {
                    const anchor = selectionAnchor(document.querySelector<HTMLElement>('article.prose-leaf'))
                    if (anchor) actions.commentAnchor(comment, anchor)
                    else toast('Select the text this comment belongs to first')
                  }}
                >
                  <TextCursorInput /> Attach to selected text
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => navigator.clipboard.writeText(comment.id)}>
                <Copy /> Copy ID for an agent
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => actions.commentDelete(comment)}>
                <Trash2 /> Delete thread
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {comment.replies.map((entry) => (
        <Entry key={entry.id} comment={comment} entry={entry} first={false} />
      ))}

      {working && (
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <span className="flex gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 160}ms` }} className="size-1 animate-pulse rounded-full bg-leaf" />
            ))}
          </span>
          {authorName(comment.statusBy ?? 'agent')} is working on it
        </div>
      )}

      {active && !resolved && (
        <Composer compact autoFocus={false} placeholder="Reply…" submitLabel="Reply" onSubmit={(body) => actions.commentReply(comment, body)} />
      )}
    </article>
  )
}
