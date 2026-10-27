import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Copy, FolderSearch, Minus, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { fetchFile, REVEAL_LABEL, texForward, texInverse, type Entry, type TexPosition } from '@/lib/api'
import { displayPath } from '@/lib/paths'
import { actions, reader, scrolls, setState, useLeaf } from '@/lib/store'
import { editAt, gotoLine } from '@/lib/jump'
import { currentPosition, onPosition, type SourcePosition } from '@/lib/tex'
import { cn } from '@/lib/utils'
import { TexActions, TexIssues, TexStatus, TexToneBar, texTone } from './TexControls'

type Pdfjs = typeof import('pdfjs-dist')
let pdfjs: Promise<Pdfjs> | null = null

/** pdf.js and its worker are separate chunks, loaded the first time a PDF opens. */
function loadPdfjs() {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })
  return pdfjs
}

const GAP = 16
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
/** Zoom per document for this browser session; 1 fits the page to the pane's width. */
const zooms = new Map<string, number>()
const FOLLOW_KEY = 'leaf.pdfFollow'

function readFollow() {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Where to land after the next layout: a saved pixel offset, or a spot on a page (kept across rebuilds and zoom). */
type Restore = { top: number } | { page: number; offset: number }

/**
 * A read-only PDF pane. Pages are laid out at their final size up front so the scroll position is
 * stable, then drawn (canvas plus a selectable text layer) only as they come near the viewport.
 * When the file changes on disk, as when a paper is rebuilt, the new pages are drawn behind the old
 * ones and swapped in at the same spot on the same page, so nothing flashes or jumps.
 *
 * A live LaTeX preview also shows its build, follows the source line being read, and double-clicking
 * a spot opens the source line that produced it.
 */
export function PdfView({
  path,
  entry,
  stamp,
  focused = true,
}: {
  path: string
  entry: Entry | undefined
  stamp: string | null | undefined
  focused?: boolean
}) {
  const pane = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const pagesHost = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<{
    path: string
    doc: PDFDocumentProxy
    task: PDFDocumentLoadingTask
    lib: Pdfjs
    sizes: { width: number; height: number }[]
  } | null>(null)
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(() => zooms.get(path) ?? 1)
  const [page, setPage] = useState(1)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const restore = useRef<Restore | null>(null)
  const settled = useRef(false)
  const scale = useRef(1)
  const project = useLeaf((s) => s.tex.find((p) => p.pdf === path))
  const [follow, setFollow] = useState(readFollow)

  useEffect(() => setZoom(zooms.get(path) ?? 1), [path])

  const remember = useCallback(() => {
    const node = viewport.current
    if (node && settled.current) scrolls.set(path, node.scrollTop)
  }, [path])

  /** The page at the top of the pane, and how far down it the pane starts. */
  const anchor = (): Restore | null => {
    const node = viewport.current
    const host = pagesHost.current
    if (!node || !host?.childElementCount) return null
    for (const holder of host.children as HTMLCollectionOf<HTMLElement>) {
      if (holder.offsetTop + holder.offsetHeight + GAP > node.scrollTop)
        return { page: Number(holder.dataset.page), offset: (node.scrollTop - holder.offsetTop) / holder.offsetHeight }
    }
    return null
  }

  useEffect(() => {
    if (!focused) return
    reader.rememberActiveScroll = remember
    reader.scrollTop = () => Math.round(viewport.current?.scrollTop ?? 0)
    reader.applyScroll = (target, top) => {
      if (target === path) viewport.current?.scrollTo({ top, behavior: 'instant' })
    }
    reader.scrollToHeading = () => false
    reader.editTarget = () => null
  }, [focused, path, remember])

  useEffect(() => {
    if (focused) setState({ headings: [], status: pdf?.path === path ? `${pdf.doc.numPages} pages` : '' })
  }, [focused, pdf, path])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new ResizeObserver(([item]) => setWidth(Math.floor(item.contentRect.width)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // A changed stamp for the same file means it was rebuilt: reload it in place.
  const lastStamp = useRef<{ path: string; stamp: string | null | undefined } | null>(null)
  useEffect(() => {
    const previous = lastStamp.current
    lastStamp.current = { path, stamp }
    if (previous?.path === path && previous.stamp && stamp && previous.stamp !== stamp) setUpdatedAt(Date.now())
    else if (previous?.path !== path) setUpdatedAt(null)
  }, [path, stamp])

  const grantId = entry?.id
  const grantError = entry?.error
  const granted = entry !== undefined
  useEffect(() => {
    if (!granted) return
    const controller = new AbortController()
    reader.markRendering(pane, true)
    ;(async () => {
      try {
        if (grantError || !grantId) throw new Error(grantError ?? 'File is unavailable.')
        const [lib, blob] = await Promise.all([loadPdfjs(), fetchFile(grantId, controller.signal)])
        const data = new Uint8Array(await blob.arrayBuffer())
        if (controller.signal.aborted) return
        const task = lib.getDocument({ data, enableXfa: false })
        const loaded = await task.promise
        const sizes = await Promise.all(
          Array.from({ length: loaded.numPages }, async (_, index) => {
            const { width, height } = (await loaded.getPage(index + 1)).getViewport({ scale: 1 })
            return { width, height }
          }),
        )
        if (controller.signal.aborted) return void task.destroy()
        // A rebuild of the open file keeps the reading position; a newly shown file restores its saved one.
        restore.current = (settled.current && pdf?.path === path ? anchor() : null) ?? { top: scrolls.get(path) ?? 0 }
        setFailure(null)
        setPdf({ path, doc: loaded, task, lib, sizes })
      } catch (error) {
        if (controller.signal.aborted) return
        setPdf(null)
        setFailure({ path, message: (error as Error).message || 'This PDF could not be read.' })
        reader.markRendering(pane, false)
      }
    })()
    return () => {
      controller.abort()
      reader.markRendering(pane, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pdf` is read only to tell a rebuild from a switch
  }, [path, granted, grantId, grantError, updatedAt, pane])

  useEffect(() => () => void pdf?.task.destroy(), [pdf])

  /** Scroll a typeset position into view and outline it; `always` scrolls even when it is visible. */
  const reveal = useCallback((position: TexPosition, always: boolean) => {
    const node = viewport.current
    const holder = pagesHost.current?.children[position.page - 1] as HTMLElement | undefined
    if (!node || !holder) return
    const top = holder.offsetTop + position.y * scale.current
    const bottom = top + position.height * scale.current
    const visible = top >= node.scrollTop + 8 && bottom <= node.scrollTop + node.clientHeight - 8
    if (always || !visible) node.scrollTo({ top: Math.max(0, top - node.clientHeight / 4), behavior: 'instant' })
    const flash = document.createElement('div')
    flash.className = 'pdf-flash'
    flash.style.left = `${position.x * scale.current - 3}px`
    flash.style.top = `${position.y * scale.current - 2}px`
    flash.style.width = `${position.width * scale.current + 6}px`
    flash.style.height = `${position.height * scale.current + 4}px`
    holder.append(flash)
    setTimeout(() => flash.remove(), 2000)
  }, [])

  // Lay out every page at its final size, then draw pages as they near the viewport.
  useEffect(() => {
    const host = pagesHost.current
    const node = viewport.current
    if (!host || !node || !pdf || pdf.path !== path || !width) return
    let cancelled = false
    const available = Math.max(200, width - 2 * GAP)
    const widest = Math.max(...pdf.sizes.map((size) => size.width))
    const factor = (available / widest) * zoom
    const tasks = new Map<number, RenderTask>()
    const drawn = new Map<number, Promise<void>>()
    const holders = pdf.sizes.map((size, index) => {
      const holder = document.createElement('div')
      holder.className = 'pdf-page'
      holder.dataset.page = String(index + 1)
      holder.style.width = `${Math.floor(size.width * factor)}px`
      holder.style.height = `${Math.floor(size.height * factor)}px`
      holder.style.setProperty('--total-scale-factor', String(factor))
      return holder
    })

    const draw = (index: number) => {
      if (!drawn.has(index)) {
        drawn.set(
          index,
          (async () => {
            const holder = holders[index]
            try {
              const pdfPage = await pdf.doc.getPage(index + 1)
              const view = pdfPage.getViewport({ scale: factor })
              const ratio = window.devicePixelRatio || 1
              const canvas = document.createElement('canvas')
              canvas.width = Math.floor(view.width * ratio)
              canvas.height = Math.floor(view.height * ratio)
              const task = pdfPage.render({ canvas, viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
              tasks.set(index, task)
              await task.promise
              const text = document.createElement('div')
              text.className = 'textLayer'
              holder.prepend(canvas, text)
              await new pdf.lib.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: text, viewport: view }).render()
            } catch (error) {
              if ((error as Error)?.name !== 'RenderingCancelledException') holder.dataset.failed = ''
            }
          })(),
        )
      }
      return drawn.get(index)!
    }

    const observer = new IntersectionObserver(
      (items) => {
        for (const item of items) if (item.isIntersecting) void draw(Number((item.target as HTMLElement).dataset.page) - 1)
      },
      { root: node, rootMargin: '1200px 0px' },
    )

    const target = restore.current
    restore.current = null
    const fresh = !host.childElementCount

    const swap = () => {
      if (cancelled) return
      scale.current = factor
      host.replaceChildren(...holders)
      holders.forEach((holder) => observer.observe(holder))
      if (target && 'top' in target) node.scrollTo({ top: target.top, behavior: 'instant' })
      else if (target) {
        const holder = holders[Math.min(target.page, holders.length) - 1]
        if (holder) node.scrollTo({ top: holder.offsetTop + target.offset * holder.offsetHeight, behavior: 'instant' })
      }
      settled.current = true
      reader.markRendering(pane, false)
      // A preview opened beside a source shows where that source is.
      const position = currentPosition()
      if (fresh && position && followRef.current) follower.current?.(position, true)
    }

    if (fresh || !target || 'top' in target) swap()
    else {
      // Keep the old pages up until the new ones at the reading position are drawn.
      const first = Math.min(target.page, holders.length) - 1
      const ready = Promise.all([first, first + 1].filter((index) => index < holders.length).map(draw))
      Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 1500))]).then(swap)
    }

    return () => {
      cancelled = true
      observer.disconnect()
      tasks.forEach((task) => task.cancel())
      // A zoom or resize lays out again from the same reading position.
      restore.current ??= anchor()
    }
  }, [pdf, path, width, zoom, pane])

  // Follow the source: scroll to the line the focused source pane shows, if it belongs to this project.
  const followRef = useRef(follow)
  followRef.current = follow
  const lastFollowed = useRef<string | null>(null)
  const follower = useRef<((position: SourcePosition, always?: boolean) => void) | null>(null)
  follower.current = (position, always = false) => {
    if (!project || !position.path.startsWith(project.root + '/') || !settled.current) return
    const switched = lastFollowed.current !== position.path
    lastFollowed.current = position.path
    texForward(position.path, position.line ?? undefined)
      .then((found) => found.pdf === path && reveal(found, always || switched))
      .catch(() => {})
  }
  useEffect(() => onPosition((position) => followRef.current && follower.current?.(position)), [])

  // Double-click a spot to open the source line that produced it.
  const onDoubleClick = (event: React.MouseEvent) => {
    if (!project) return
    const holder = (event.target as HTMLElement).closest<HTMLElement>('.pdf-page')
    if (!holder) return
    const box = holder.getBoundingClientRect()
    const x = (event.clientX - box.left) / scale.current
    const y = (event.clientY - box.top) / scale.current
    document.getSelection()?.removeAllRanges()
    // ⌥-double-click opens the editor on that line; a plain double-click shows it.
    const edit = event.altKey
    texInverse(path, Number(holder.dataset.page), x, y)
      .then((found) => (edit ? editAt(found.path, 'edit', { line: found.line }) : gotoLine(found.path, found.line)))
      .catch((error) => setState({ status: (error as Error).message }))
  }

  // Leaving this file for another: keep its position, and start the next one unsettled.
  useEffect(
    () => () => {
      remember()
      settled.current = false
      restore.current = null
    },
    [path, remember],
  )


  const onScroll = () => {
    remember()
    const node = viewport.current
    const host = pagesHost.current
    if (!node || !host) return
    const middle = node.scrollTop + node.clientHeight / 3
    let current = 1
    for (const holder of host.children as HTMLCollectionOf<HTMLElement>) {
      if (holder.offsetTop > middle) break
      current = Number(holder.dataset.page)
    }
    setPage(current)
  }

  const changeZoom = (next: number) => {
    const value = Math.min(3, Math.max(0.5, Math.round(next * 100) / 100))
    zooms.set(path, value)
    setZoom(value)
  }
  const step = (direction: 1 | -1) =>
    changeZoom(direction > 0 ? (ZOOMS.find((z) => z > zoom + 0.001) ?? 3) : ([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? 0.5))

  const toggleFollow = () => {
    const next = !follow
    setFollow(next)
    try {
      localStorage.setItem(FOLLOW_KEY, next ? 'on' : 'off')
    } catch {
      /* A per-browser convenience; the default applies when storage is unavailable. */
    }
  }

  const current = pdf?.path === path ? pdf : null
  const failed = failure?.path === path ? failure : null
  const shown = displayPath(project ? project.root : path)
  const cut = shown.lastIndexOf('/')
  const build = project?.lastBuild
  const issues = !!build && (!build.ok || build.warningCount + build.boxCount > 0)
  const button =
    'grid size-6 cursor-pointer place-items-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink disabled:pointer-events-none disabled:opacity-40'

  return (
    <div
      onPointerDownCapture={() => !focused && actions.focus(path)}
      data-pane-focused={focused || undefined}
      className="relative flex min-h-0 flex-1 flex-col bg-chrome/60"
    >
      <div className="print-hide flex h-9 shrink-0 items-center gap-3 border-b border-rule bg-paper px-3 text-[12px] text-ink-muted">
        <span className="min-w-0 flex-1 truncate" title={project ? `Compiled from ${project.main}. The PDF is at ${path}` : path}>
          <span className="text-ink-faint">{shown.slice(0, cut + 1)}</span>
          <span className="text-ink">{shown.slice(cut + 1)}</span>
          {project && <span className="text-ink-faint"> · live PDF</span>}
          {updatedAt && <span className="ml-2 text-leaf-ink">Updated</span>}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            className={button}
            aria-label="Copy PDF path"
            title={`Copy the PDF's full path: ${path}`}
            onClick={() => navigator.clipboard.writeText(path).then(() => toast('Copied the PDF path'))}
          >
            <Copy className="size-3.5" />
          </button>
          <button type="button" className={button} aria-label={REVEAL_LABEL} title={REVEAL_LABEL} onClick={() => actions.reveal(path)}>
            <FolderSearch className="size-3.5" />
          </button>
        </span>
        {current && (
          <>
            <span className="tabular-nums">
              {page} / {current.doc.numPages}
            </span>
            <div className="flex items-center gap-0.5">
              <button type="button" className={button} aria-label="Zoom out" title="Zoom out" disabled={zoom <= 0.5} onClick={() => step(-1)}>
                <Minus className="size-3.5" />
              </button>
              <button
                type="button"
                className="h-6 min-w-12 cursor-pointer rounded-md px-1 tabular-nums transition-colors hover:bg-accent hover:text-ink"
                title="Fit to width"
                onClick={() => changeZoom(1)}
              >
                {zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}
              </button>
              <button type="button" className={button} aria-label="Zoom in" title="Zoom in" disabled={zoom >= 3} onClick={() => step(1)}>
                <Plus className="size-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
      {project && (
        <div className="print-hide shrink-0 border-b border-rule bg-paper text-[12px] text-ink-muted">
          <div className={cn('relative flex h-8 items-center gap-2 px-3 transition-colors', `tex-tone-${texTone(project)}`)}>
            <TexToneBar project={project} />
            <TexStatus project={project} />
            <span className="flex-1" />
            <button
              type="button"
              role="switch"
              aria-checked={follow}
              onClick={toggleFollow}
              title={
                follow
                  ? 'The PDF follows the source you read or edit. Click to stop.'
                  : 'The PDF stays where you leave it. Click to follow the source.'
              }
              className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-muted transition-colors hover:bg-accent hover:text-ink"
            >
              <span className={cn('relative h-3.5 w-6 rounded-full transition-colors', follow ? 'bg-leaf' : 'bg-rule-strong')}>
                <span className={cn('absolute top-0.5 size-2.5 rounded-full bg-paper shadow-sm transition-all', follow ? 'left-3' : 'left-0.5')} />
              </span>
              Follow
            </button>
            <TexActions project={project} />
          </div>
          {build && !build.ok && (
            <p className="border-t border-rule bg-destructive/8 px-3 py-1.5 text-destructive">
              The last build failed{project.pdfExists ? '; this is the last PDF that built' : ''}. Click an error to open its line.
            </p>
          )}
          {issues && (
            <div className="max-h-[30vh] overflow-y-auto border-t border-rule px-1 py-1">
              <TexIssues project={project} />
            </div>
          )}
        </div>
      )}
      <div ref={viewport} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
        {failed && (
          <div className="mx-auto mt-10 max-w-md rounded-[10px] border border-rule bg-paper px-5 py-4">
            <p className="font-medium text-ink">This PDF can't be shown</p>
            <p className="mt-1 text-sm text-ink-muted">{failed.message}</p>
          </div>
        )}
        {!current && !failed && <p className="mt-10 animate-pulse text-center text-sm text-ink-faint">Loading PDF…</p>}
        <div ref={pagesHost} onDoubleClick={onDoubleClick} className={cn('pdf-pages', !current && 'hidden')} style={{ padding: GAP, gap: GAP }} />
      </div>
    </div>
  )
}
