import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import type { Comment } from '@/lib/api'
import { buildIndex, rangeBetween, resolve, selectionAnchor, type TextIndex } from '@/lib/anchors'
import { displayPath } from '@/lib/paths'
import { actions, getState, setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { CommentCard, Composer, type Placement } from './CommentCard'

const GAP = 10
const NONE: Comment[] = []

export function documentComments(comments: Comment[] | undefined, path: string) {
  return (comments ?? NONE).filter((comment) => comment.path === path)
}

/** The instruction to paste into any agent; it only needs the leaf CLI. */
export function agentPrompt(path: string) {
  const file = displayPath(path)
  return [
    `Address my Leaf comments on ${file}.`,
    `Read them with \`leaf comments ${file} --format md\`.`,
    `For each one: \`leaf comment working ID --author <your name>\`, edit the file, then \`leaf comment resolve ID "what you changed" --author <your name>\`.`,
    `If a comment needs my decision or you disagree, reply with \`leaf comment reply ID "…" --author <your name>\` and leave it open.`,
  ].join(' ')
}

interface Placed {
  comment: Comment | 'draft'
  placement: Placement
  range: Range | null
}

/**
 * Comment threads beside the reading column, each level with the passage it discusses. Passages
 * are highlighted with the CSS Custom Highlight API, so the rendered document is never mutated.
 */
export function CommentsRail({
  path,
  article,
  version,
  showResolved,
}: {
  path: string
  article: RefObject<HTMLElement | null>
  version: unknown
  showResolved: boolean
}) {
  const all = useLeaf((s) => s.workspace?.comments)
  const active = useLeaf((s) => s.activeComment)
  const draft = useLeaf((s) => s.draft)
  const comments = useMemo(
    () => documentComments(all, path).filter((c) => showResolved || c.status !== 'resolved' || c.id === active),
    [all, path, showResolved, active],
  )
  const rail = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLElement>())
  const [index, setIndex] = useState<TextIndex | null>(null)
  const [tops, setTops] = useState<Record<string, number>>({})
  const [tick, setTick] = useState(0)

  // Re-index whenever the rendered document changes (navigation, live reload, view switch).
  useEffect(() => {
    if (article.current) setIndex(buildIndex(article.current))
  }, [article, version])

  const placed = useMemo<Placed[]>(() => {
    if (!index) return []
    const items: Placed[] = comments.map((comment) => {
      if (!comment.anchor) return { comment, placement: 'document', range: null }
      const found = resolve(comment.anchor, index)
      if (found.state === 'detached' || found.state === 'ambiguous') return { comment, placement: found.state, range: null }
      return { comment, placement: found.state, range: rangeBetween(index, found.start, found.end) }
    })
    if (draft?.path === path) {
      const found = draft.anchor ? resolve(draft.anchor, index) : null
      const range = found && 'start' in found ? rangeBetween(index, found.start, found.end) : null
      items.push({ comment: 'draft', placement: range ? 'attached' : 'document', range })
    }
    return items
  }, [comments, draft, index, path])

  // Highlights: every open thread's passage, plus a stronger one for the thread in focus.
  useEffect(() => {
    if (!('highlights' in CSS)) return
    const ranges = placed.filter((p) => p.range && (p.comment === 'draft' || p.comment.status !== 'resolved'))
    const key = (p: Placed) => (p.comment === 'draft' ? 'draft' : p.comment.id)
    CSS.highlights.set('leaf-comment', new Highlight(...ranges.map((p) => p.range!)))
    CSS.highlights.set('leaf-comment-active', new Highlight(...ranges.filter((p) => key(p) === active).map((p) => p.range!)))
    return () => {
      CSS.highlights.delete('leaf-comment')
      CSS.highlights.delete('leaf-comment-active')
    }
  }, [placed, active])

  // Click a highlighted passage to focus its thread; click plain text to clear focus.
  useEffect(() => {
    const node = article.current
    if (!node) return
    const onClick = (event: MouseEvent) => {
      if (!document.getSelection()?.isCollapsed) return
      const point = document.caretPositionFromPoint?.(event.clientX, event.clientY)
      if (!point) return
      const hits = placed.filter((p) => p.range?.isPointInRange(point.offsetNode, point.offset))
      hits.sort((a, b) => a.range!.toString().length - b.range!.toString().length)
      const hit = hits[0]
      if (hit) setState({ activeComment: hit.comment === 'draft' ? 'draft' : hit.comment.id })
      else if (getState().activeComment && getState().activeComment !== 'draft') setState({ activeComment: null })
    }
    node.addEventListener('click', onClick)
    return () => node.removeEventListener('click', onClick)
  }, [article, placed])

  // Measure where each passage sits relative to the rail; cards follow their passages.
  const measure = useCallback(() => {
    const origin = rail.current?.getBoundingClientRect().top
    if (origin === undefined) return
    const next: Record<string, number> = {}
    for (const p of placed) {
      if (!p.range) continue
      const rect = p.range.getClientRects()[0] ?? p.range.getBoundingClientRect()
      next[p.comment === 'draft' ? 'draft' : p.comment.id] = rect.top - origin
    }
    setTops(next)
  }, [placed])

  useLayoutEffect(measure, [measure])
  useEffect(() => {
    const node = article.current
    if (!node) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => observer.disconnect()
  }, [article, measure])

  // Card heights change as threads grow; re-run layout when any card resizes.
  useEffect(() => {
    const observer = new ResizeObserver(() => setTick((t) => t + 1))
    for (const node of cards.current.values()) observer.observe(node)
    if (header.current) observer.observe(header.current)
    return () => observer.disconnect()
  }, [placed])

  /*
   * Layout: cards keep their passage's height when they can. The focused card wins its exact
   * spot; cards above it stack upward from it, cards below stack downward, never overlapping.
   */
  const layout = useMemo(() => {
    void tick
    const floor = (header.current?.offsetHeight ?? 0) + GAP
    const anchored = placed
      .filter((p) => p.range)
      .map((p) => {
        const id = p.comment === 'draft' ? 'draft' : p.comment.id
        return { id, want: Math.max(floor, tops[id] ?? floor), height: cards.current.get(id)?.offsetHeight ?? 96 }
      })
      .sort((a, b) => a.want - b.want)
    const top: Record<string, number> = {}
    const pivot = anchored.findIndex((item) => item.id === active)
    const forward = (from: number, start: number) => {
      let cursor = start
      for (let i = from; i < anchored.length; i++) {
        top[anchored[i].id] = Math.max(anchored[i].want, cursor)
        cursor = top[anchored[i].id] + anchored[i].height + GAP
      }
    }
    if (pivot < 0) forward(0, floor)
    else {
      top[anchored[pivot].id] = anchored[pivot].want
      let limit = anchored[pivot].want - GAP
      let fits = true
      for (let i = pivot - 1; i >= 0; i--) {
        top[anchored[i].id] = Math.min(anchored[i].want, limit - anchored[i].height)
        limit = top[anchored[i].id] - GAP
        if (top[anchored[i].id] < floor) fits = false
      }
      if (fits) forward(pivot + 1, anchored[pivot].want + anchored[pivot].height + GAP)
      else forward(0, floor)
    }
    const bottom = anchored.reduce((max, item) => Math.max(max, (top[item.id] ?? 0) + item.height), 0)
    return { top, bottom }
  }, [placed, tops, active, tick])

  const register = (id: string) => (node: HTMLElement | null) => {
    if (node) cards.current.set(id, node)
    else cards.current.delete(id)
  }

  const unplaced = placed.filter((p) => !p.range)
  const submitDraft = async (body: string) => {
    if (!draft) return 'No draft'
    const failed = await actions.commentAdd(draft.path, body, draft.anchor)
    if (!failed) {
      setState({ draft: null, activeComment: null })
      document.getSelection()?.removeAllRanges()
    }
    return failed
  }
  const cancelDraft = () => setState({ draft: null, activeComment: null })

  const renderItem = (p: Placed) =>
    p.comment === 'draft' ? (
      <div className="grid gap-2 rounded-xl border border-leaf/50 bg-chrome-raised p-3 shadow-float">
        <span className="text-[11.5px] font-medium text-ink-muted">
          {p.range ? 'New comment' : 'New comment on the whole document'}
        </span>
        <Composer placeholder="Add a comment…" submitLabel="Comment" onSubmit={submitDraft} onCancel={cancelDraft} />
      </div>
    ) : (
      <CommentCard comment={p.comment} placement={p.placement} active={active === p.comment.id} />
    )

  return (
    <div ref={rail} className="relative" style={{ minHeight: layout.bottom + 40 }}>
      <div ref={header} className="grid gap-2">
        {unplaced.map((p) => (
          <div key={p.comment === 'draft' ? 'draft' : p.comment.id} ref={register(p.comment === 'draft' ? 'draft' : p.comment.id)}>
            {renderItem(p)}
          </div>
        ))}
      </div>
      {placed
        .filter((p) => p.range)
        .map((p) => {
          const id = p.comment === 'draft' ? 'draft' : p.comment.id
          return (
            <div
              key={id}
              ref={register(id)}
              style={{ top: layout.top[id] ?? 0 }}
              className={cn('absolute inset-x-0 transition-[top] duration-200 ease-out-expo', active === id && 'z-10')}
            >
              {renderItem(p)}
            </div>
          )
        })}
    </div>
  )
}

/** Floating "Comment" button over a text selection in the document. */
export function SelectionCommentButton({ path, article }: { path: string; article: RefObject<HTMLElement | null> }) {
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const update = () => {
      const selection = document.getSelection()
      const node = article.current
      if (!selection || selection.isCollapsed || !node || !selection.rangeCount) return setSpot(null)
      const range = selection.getRangeAt(0)
      if (!node.contains(range.commonAncestorContainer)) return setSpot(null)
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      setSpot({ x: last.right, y: last.top })
    }
    const hide = () => setSpot(null)
    document.addEventListener('selectionchange', update)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('scroll', hide, true)
    }
  }, [article])

  if (!spot) return null
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => startComment(path, article.current)}
      style={{ left: Math.min(spot.x + 6, window.innerWidth - 120), top: Math.max(8, spot.y - 38) }}
      className="fixed z-40 flex h-8 animate-in items-center gap-1.5 rounded-lg border border-rule-strong bg-chrome-raised px-2.5 text-[12.5px] font-medium text-ink shadow-float duration-150 fade-in-0 zoom-in-95 hover:bg-accent"
    >
      <MessageSquarePlus className="size-3.5 text-leaf" /> Comment
    </button>
  )
}

/** Start a draft from the current selection, or on the whole document when nothing is selected. */
export function startComment(path: string, root: HTMLElement | null) {
  const selection = document.getSelection()
  const anchor = selectionAnchor(root)
  if (selection && !selection.isCollapsed && !anchor && root?.contains(selection.anchorNode)) {
    toast('Select text in the document to comment on it')
    return
  }
  setState({ draft: { path, anchor }, activeComment: 'draft', sidePanel: 'comments', outlineOpen: true })
}
