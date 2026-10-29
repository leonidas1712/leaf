/*
 * Comments on a live LaTeX PDF. A passage selected in the PDF becomes a comment on the .tex source
 * behind it: SyncTeX names the file and lines, and the server finds the selected words there, so
 * the thread is an ordinary source comment that agents read with `leaf comments`. Open threads on
 * the project's sources are highlighted back in the PDF: SyncTeX gives the lines' band on the page,
 * and the passage's letters are found in that page's text layer near it. When they can't be found
 * (math, macros), the band itself is marked.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowUpRight, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { texAnchor, texComments, type CommentAnchor, type PdfComment, type PdfPoint, type TexProject } from '@/lib/api'
import { forgetSelection, recentSelection, shareHighlight } from '@/lib/anchors'
import { gotoLine } from '@/lib/jump'
import { basename, displayPath } from '@/lib/paths'
import { actions, reader, setState, useLeaf } from '@/lib/store'
import { CommentCard, Composer } from './CommentCard'

/** Letters and digits of a page's text layer, lowercased, with the text node and offset of each. */
function pageLetters(layer: HTMLElement) {
  const nodes: Text[] = []
  const chars: string[] = []
  const nodeAt: number[] = []
  const offsetAt: number[] = []
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const index = nodes.push(node) - 1
    for (let i = 0; i < node.data.length; i++) {
      for (const part of node.data[i].normalize('NFKC')) {
        if (!/[\p{L}\p{N}]/u.test(part)) continue
        chars.push(part.toLowerCase())
        nodeAt.push(index)
        offsetAt.push(i)
      }
    }
  }
  return { text: chars.join(''), nodes, nodeAt, offsetAt }
}

/** The selected text as the PDF shows it: lines joined by a space, words hyphenated across lines rejoined. */
function selectedText(range: Range, root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  let lastTop: number | null = null
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    const piece = node.data.slice(start, end)
    if (!piece) continue
    const top = node.parentElement?.getBoundingClientRect().top ?? 0
    if (lastTop !== null && Math.abs(top - lastTop) > 2) {
      if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(piece)) text = text.slice(0, -1)
      else if (!/\s$/.test(text)) text += ' '
    }
    lastTop = top
    text += piece
  }
  return text.replace(/\s+/g, ' ').trim()
}

interface Draft {
  path: string
  line: number
  match: 'text' | 'line'
  anchor: CommentAnchor
  top: number
  left: number
}

interface Open {
  id: string
  top: number
  left: number
}

const CARD_WIDTH = 340

export function PdfComments({
  pdf,
  project,
  host,
  viewport,
  scale,
  version,
  focused,
}: {
  pdf: string
  project: TexProject
  host: RefObject<HTMLDivElement | null>
  viewport: RefObject<HTMLDivElement | null>
  scale: RefObject<number>
  /** Changes whenever the pages are laid out again (a rebuild, zoom, or resize). */
  version: unknown
  focused: boolean
}) {
  const all = useLeaf((s) => s.workspace?.comments)
  const active = useLeaf((s) => s.activeComment)
  const [placed, setPlaced] = useState<PdfComment[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [open, setOpen] = useState<Open | null>(null)
  const [owner] = useState(() => Symbol(pdf))
  const ranges = useRef(new Map<string, Range>())

  // Where the open threads fall in this build of the PDF.
  const built = project.lastBuild?.finishedAt
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      texComments(pdf)
        .then((result) => !cancelled && setPlaced(result.comments))
        .catch(() => !cancelled && setPlaced([]))
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pdf, all, built, version])

  /** Highlight each thread's passage on the pages drawn so far; mark the band where it can't be found. */
  const paint = useCallback(() => {
    const pages = host.current
    if (!pages) return
    for (const band of pages.querySelectorAll('.pdf-comment-band')) band.remove()
    const found = new Map<string, Range>()
    const factor = scale.current ?? 1
    const letters = new Map<number, ReturnType<typeof pageLetters>>()
    const lettersOf = (page: number) => {
      const layer = pages.children[page - 1]?.querySelector<HTMLElement>('.textLayer')
      if (!layer?.childElementCount) return null
      if (!letters.has(page)) letters.set(page, pageLetters(layer))
      return letters.get(page)!
    }
    for (const comment of placed) {
      const holder = pages.children[comment.page - 1] as HTMLElement | undefined
      if (!holder) continue
      let range: Range | null = null
      for (const page of [comment.page, comment.page + 1]) {
        const index = lettersOf(page)
        if (!index || comment.letters.length < 2) continue
        const origin = (pages.children[page - 1] as HTMLElement).getBoundingClientRect().top
        let best: { at: number; distance: number } | null = null
        for (let at = index.text.indexOf(comment.letters); at >= 0; at = index.text.indexOf(comment.letters, at + 1)) {
          const span = index.nodes[index.nodeAt[at]].parentElement
          const y = span ? (span.getBoundingClientRect().top - origin) / factor : 0
          const distance = page === comment.page ? Math.abs(y - comment.y) : y + 1000
          if (!best || distance < best.distance) best = { at, distance }
        }
        if (best && best.distance < 400) {
          const end = best.at + comment.letters.length - 1
          range = document.createRange()
          range.setStart(index.nodes[index.nodeAt[best.at]], index.offsetAt[best.at])
          range.setEnd(index.nodes[index.nodeAt[end]], index.offsetAt[end] + 1)
          break
        }
      }
      if (range) found.set(comment.id, range)
      else if (holder.querySelector('.textLayer')) {
        const band = document.createElement('div')
        band.className = 'pdf-comment-band'
        band.dataset.comment = comment.id
        if (comment.id === active) band.dataset.active = ''
        band.style.top = `${(comment.y - 3) * factor}px`
        band.style.height = `${(Math.max(comment.height, 9) + 6) * factor}px`
        band.title = 'A comment on these lines. Click to read it.'
        holder.append(band)
      }
    }
    ranges.current = found
    shareHighlight('leaf-comment', owner, [...found.values()])
    shareHighlight('leaf-comment-active', owner, [...found].filter(([id]) => id === active).map(([, range]) => range))
  }, [host, scale, placed, active, owner])

  useEffect(() => {
    paint()
    const pages = host.current
    pages?.addEventListener('leaf:text-layer', paint)
    return () => pages?.removeEventListener('leaf:text-layer', paint)
  }, [paint, host])

  useEffect(
    () => () => {
      shareHighlight('leaf-comment', owner, [])
      shareHighlight('leaf-comment-active', owner, [])
    },
    [owner],
  )

  /** A spot in the scrolled content just below a viewport rectangle, kept inside the pane. */
  const spotBelow = useCallback(
    (rect: { left: number; bottom: number }) => {
      const node = viewport.current!
      const box = node.getBoundingClientRect()
      return {
        top: rect.bottom - box.top + node.scrollTop + 8,
        left: Math.max(8, Math.min(rect.left - box.left + node.scrollLeft, node.scrollLeft + node.clientWidth - CARD_WIDTH - 16)),
      }
    },
    [viewport],
  )

  // Click a highlighted passage or a marked band to read its thread.
  useEffect(() => {
    const pages = host.current
    if (!pages) return
    const onClick = (event: MouseEvent) => {
      if (!document.getSelection()?.isCollapsed) return
      const band = (event.target as HTMLElement).closest<HTMLElement>('.pdf-comment-band')
      let id = band?.dataset.comment
      if (!id) {
        const point = document.caretPositionFromPoint?.(event.clientX, event.clientY)
        const hits = point ? [...ranges.current].filter(([, range]) => range.isPointInRange(point.offsetNode, point.offset)) : []
        id = hits.sort((a, b) => a[1].toString().length - b[1].toString().length)[0]?.[0]
      }
      if (!id) return
      setDraft(null)
      setOpen({ id, ...spotBelow({ left: event.clientX - 40, bottom: event.clientY + 6 }) })
      setState({ activeComment: id })
    }
    pages.addEventListener('click', onClick)
    return () => pages.removeEventListener('click', onClick)
  }, [host, spotBelow])

  /** Start a comment on the selected passage: find its source, then show the composer under it. */
  const start = useCallback(async () => {
    const pages = host.current
    const range = recentSelection(pages)
    if (!pages || !range) {
      toast('Select text in the PDF to comment on it')
      return true
    }
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1)
    const text = selectedText(range, pages)
    if (!rects.length || !text) {
      toast('Select text in the PDF to comment on it')
      return true
    }
    const toPage = (x: number, y: number): PdfPoint | null => {
      for (const holder of pages.children as HTMLCollectionOf<HTMLElement>) {
        const box = holder.getBoundingClientRect()
        if (y >= box.top && y <= box.bottom && x >= box.left - 4 && x <= box.right + 4) {
          const factor = scale.current ?? 1
          return { page: Number(holder.dataset.page), x: (x - box.left) / factor, y: (y - box.top) / factor }
        }
      }
      return null
    }
    const first = rects[0]
    const last = rects[rects.length - 1]
    const from = toPage(first.left + 1, first.top + first.height / 2)
    const to = toPage(last.right - 1, last.top + last.height / 2)
    if (!from || !to) {
      toast('Select text on a page to comment on it')
      return true
    }
    try {
      const found = await texAnchor(pdf, from, to, text)
      setOpen(null)
      setDraft({ path: found.path, line: found.line, match: found.match, anchor: found.anchor, ...spotBelow(last) })
    } catch (error) {
      toast((error as Error).message)
    }
    return true
  }, [host, pdf, scale, spotBelow])

  useEffect(() => {
    if (!focused) return
    reader.commentOnPdf = start
    return () => {
      if (reader.commentOnPdf === start) reader.commentOnPdf = null
    }
  }, [focused, start])

  // Esc closes the card or composer; so does pressing anywhere else in the pane.
  useEffect(() => {
    if (!draft && !open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target as HTMLElement).closest?.('textarea')) {
        setDraft(null)
        setOpen(null)
      }
    }
    const onDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('[data-pdf-card], [role="menu"], [data-radix-popper-content-wrapper]')) {
        setDraft(null)
        setOpen(null)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [draft, open])

  useEffect(() => {
    setDraft(null)
    setOpen(null)
  }, [pdf, version])

  const submit = async (body: string) => {
    if (!draft) return 'No draft'
    const failed = await actions.commentAdd(draft.path, body, draft.anchor)
    if (failed) return failed
    const { path, line } = draft
    setDraft(null)
    forgetSelection()
    document.getSelection()?.removeAllRanges()
    toast(`Comment added on ${basename(path)}, line ${line}`, { action: { label: 'Show', onClick: () => gotoLine(path, line) } })
  }

  const thread = open ? all?.find((comment) => comment.id === open.id) : undefined
  const where = open && placed.find((comment) => comment.id === open.id)
  const card = 'absolute z-30 grid gap-2 rounded-xl border border-rule-strong bg-chrome-raised p-3 shadow-float'

  return (
    <>
      {draft && (
        <div data-pdf-card className={card} style={{ top: draft.top, left: draft.left, width: CARD_WIDTH }}>
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[11.5px] font-medium text-ink-muted" title={draft.path}>
              New comment on {displayPath(draft.path).replace(displayPath(project.root) + '/', '')} · line {draft.line}
            </span>
            <button type="button" aria-label="Cancel" className="text-ink-faint hover:text-ink" onClick={() => setDraft(null)}>
              <X className="size-3.5" />
            </button>
          </div>
          <code className="line-clamp-3 rounded-md bg-code px-2 py-1 font-mono text-[11.5px] break-words whitespace-pre-wrap text-ink-soft">
            {draft.anchor.quote}
          </code>
          {draft.match === 'line' && (
            <p className="flex items-center gap-1 text-[11.5px] text-ink-faint">
              <TriangleAlert className="size-3" /> The exact words weren't found in the source; this comment goes on these lines.
            </p>
          )}
          <Composer placeholder="Add a comment…" submitLabel="Comment" onSubmit={submit} onCancel={() => setDraft(null)} />
        </div>
      )}
      {open && thread && (
        <div data-pdf-card className="absolute z-30 grid gap-1.5" style={{ top: open.top, left: open.left, width: CARD_WIDTH }}>
          <CommentCard comment={thread} placement="attached" active />
          <button
            type="button"
            className="flex h-7 items-center justify-center gap-1 justify-self-end rounded-md border border-rule bg-chrome-raised px-2 text-[12px] text-ink-muted shadow-float hover:bg-accent hover:text-ink"
            onClick={() => {
              setOpen(null)
              if (where) gotoLine(where.path, where.line)
              setState({ activeComment: thread.id, sidePanel: 'comments' })
            }}
          >
            {basename(thread.path)}
            {where ? `, line ${where.line}` : ''} <ArrowUpRight className="size-3.5" />
          </button>
        </div>
      )}
    </>
  )
}
