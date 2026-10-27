import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { attachImageResize, frameImage } from '@/lib/images'
import { fetchDocumentImage, fetchFile, type Entry, type ReaderPrefs } from '@/lib/api'
import { cn } from '@/lib/utils'
import { enhance, escapeHTML, highlight, isMarkdown, readingStats, renderMarkdown, resolveRelative } from '@/lib/markdown'
import { renderDiagram } from '@/lib/mermaid'
import { actions, currentSplit, getState, isPdf, reader, scrolls, setState, DOCUMENT_FILE, useLeaf, type Heading } from '@/lib/store'
import { diskChanged } from '@/lib/drafts'
import { anchorFor, buildIndex, selectionIn, shareHighlight } from '@/lib/anchors'
import type { SourceRange } from '@/lib/jump'
import { findInSource } from '@/lib/sourcePosition'
import { takeLine } from '@/lib/jump'
import { isTex, reportPosition } from '@/lib/tex'
import { TexBar } from './TexControls'
import { EditBar } from './EditBar'
import { FindBar } from './FindBar'
import { Editor } from './Editor'
import { DiagramPanel, type DiagramResult } from './DiagramPanel'
import { DocumentHeader } from './DocumentHeader'
import { SelectionCommentButton } from './CommentsRail'
import { SidePanel } from './SidePanel'

interface Rendered {
  path: string
  /** The text rendered, and whether it shows as a code block (so rendered text and source match). */
  text: string
  code: boolean
  html: string
  stats: { words: number; minutes: number }
  diagrams: { mount: HTMLElement; source: string; result: DiagramResult }[]
}

interface Failure {
  path: string
  message: string
}

/** The source line being read: a third of the way down the pane, where jumps place lines too. */
function lineInView(code: HTMLElement, viewport: HTMLElement): number | null {
  const view = viewport.getBoundingClientRect()
  const box = code.getBoundingClientRect()
  const y = Math.max(view.top + view.height / 3, box.top + 2)
  if (y > Math.min(box.bottom, view.bottom)) return null
  const x = box.left + 24
  const caret = document.caretPositionFromPoint?.(x, y)
  const node = caret ? caret.offsetNode : document.caretRangeFromPoint?.(x, y)?.startContainer
  const offset = caret ? caret.offset : (document.caretRangeFromPoint?.(x, y)?.startOffset ?? 0)
  if (!node || !code.contains(node)) return null
  const before = document.createRange()
  before.setStart(code, 0)
  before.setEnd(node, offset)
  return before.toString().split('\n').length
}

/** A range over one source line of a code block. */
function rangeOfLine(code: HTMLElement, line: number): Range | null {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let current = 1
  let start: [Text, number] | null = null
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i++) {
      if (current === line && !start) start = [node, i]
      if (node.data[i] === '\n') {
        if (start) {
          const range = document.createRange()
          range.setStart(start[0], start[1])
          range.setEnd(node, i)
          return range
        }
        current++
      }
    }
  }
  if (!start) return null
  const range = document.createRange()
  range.setStart(start[0], start[1])
  range.setEndAfter(code.lastChild ?? code)
  return range
}

const lineFlash = Symbol('line flash')
let flashTimer: ReturnType<typeof setTimeout> | undefined

/** Scroll a source line to a third of the way down the pane and flash it. */
function showLine(code: HTMLElement, viewport: HTMLElement, line: number) {
  const range = rangeOfLine(code, line)
  if (!range) return
  const rect = range.getBoundingClientRect()
  const view = viewport.getBoundingClientRect()
  viewport.scrollTo({ top: viewport.scrollTop + rect.top - view.top - view.height / 3, behavior: 'instant' })
  shareHighlight('leaf-line', lineFlash, [range])
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => shareHighlight('leaf-line', lineFlash, []), 1600)
}

const CODE_LANGUAGE: Record<string, string> = { json: 'json', yaml: 'yaml', yml: 'yaml', csv: 'plaintext', log: 'plaintext', txt: 'plaintext', tex: 'latex', bib: 'latex' }
/**
 * The reading surface. Rendering is sequenced: a newer request always wins, scroll restores
 * instantly only after diagrams and images have laid out, and the sync loop is held off while
 * a render is in flight so "applied" means the reader really shows the revision.
 *
 * In a split each pane has its own view. Only the focused one answers live commands and
 * publishes its headings; pressing anywhere in the other pane focuses it.
 */
export function DocumentView({
  path,
  entry,
  source,
  theme,
  entries,
  stamp,
  prefs,
  focused = true,
}: {
  path: string
  entry: Entry | undefined
  source: boolean
  theme: 'light' | 'dark'
  entries: Map<string, Entry>
  stamp: string | null | undefined
  prefs: ReaderPrefs
  focused?: boolean
}) {
  const pane = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)
  const sequence = useRef(0)
  const displayed = useRef<string | null>(null)
  const pendingHash = useRef<string | null>(null)
  const urls = useRef<string[]>([])
  const grants = useRef(entries)
  grants.current = entries
  const [rendered, setRendered] = useState<Rendered | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [width, setWidth] = useState(720)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [outline, setOutline] = useState<{ headings: Heading[]; status: string }>({ headings: [], status: '' })
  const busy = useRef(false)
  const setBusy = useCallback(
    (value: boolean) => {
      busy.current = value
      reader.markRendering(pane, value)
    },
    [pane],
  )

  // A changed stamp for the same document means an agent rewrote it: re-render in place.
  const lastStamp = useRef<{ path: string; stamp: string | null | undefined } | null>(null)
  useEffect(() => {
    const previous = lastStamp.current
    lastStamp.current = { path, stamp }
    if (previous?.path === path && previous.stamp && stamp && previous.stamp !== stamp) setUpdatedAt(Date.now())
    else if (previous?.path !== path) setUpdatedAt(null)
  }, [path, stamp])

  const remember = useCallback(() => {
    if (displayed.current && viewport.current && !busy.current)
      scrolls.set(displayed.current, viewport.current.scrollTop)
  }, [])

  const scrollToHeading = useCallback((target: string) => {
    const heading = [...(article.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? [])].find(
      (node) => node.id === target || node.textContent?.replace(/#$/, '').trim() === target,
    )
    if (!heading) return false
    heading.scrollIntoView({ behavior: 'instant', block: 'start' })
    heading.classList.remove('heading-flash')
    void heading.offsetWidth
    heading.classList.add('heading-flash')
    return true
  }, [])

  const shownRef = useRef(rendered)
  shownRef.current = rendered
  /** The editor opens on the selection, else on the line being read (a third of the way down). */
  const editTarget = useCallback((): SourceRange | { line: number } | null => {
    const node = article.current
    const view = viewport.current
    const shown = shownRef.current
    if (!node || !view || !shown || shown.path !== path || displayed.current !== path) return null
    const range = selectionIn(node)
    const code = shown.code ? node.querySelector<HTMLElement>('pre > code') : null
    if (code) {
      if (range && code.contains(range.startContainer)) {
        const before = document.createRange()
        before.setStart(code, 0)
        before.setEnd(range.startContainer, range.startOffset)
        const from = before.toString().length
        return { from, to: from + range.toString().length }
      }
      const line = lineInView(code, view)
      return line ? { line } : null
    }
    if (range) {
      const anchor = anchorFor(range, node, buildIndex(node))
      if (anchor) return findInSource(shown.text, anchor.quote, true, anchor.prefix, anchor.suffix)
    }
    // Nothing selected: the first block reaching a third of the way down the pane, else the last one.
    const box = view.getBoundingClientRect()
    const reading = box.top + box.height / 3
    const blocks = [...node.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, figcaption')]
    const block = blocks.find((item) => item.getBoundingClientRect().bottom >= reading) ?? blocks.at(-1)
    if (!block) return null
    const whole = document.createRange()
    whole.selectNodeContents(block)
    const anchor = anchorFor(whole, node, buildIndex(node))
    const found = anchor && findInSource(shown.text, anchor.quote, true, anchor.prefix, anchor.suffix)
    return found ? { from: found.from, to: found.from } : null
  }, [path])

  useEffect(() => {
    if (!focused) return
    reader.rememberActiveScroll = remember
    reader.scrollTop = () => Math.round(viewport.current?.scrollTop ?? 0)
    reader.applyScroll = (target, top) => {
      if (displayed.current === target) viewport.current?.scrollTo({ top, behavior: 'instant' })
    }
    reader.scrollToHeading = scrollToHeading
    reader.editTarget = editTarget
  }, [focused, remember, scrollToHeading, editTarget])

  useEffect(() => {
    reader.headingFinders.set(pane, scrollToHeading)
    return () => void reader.headingFinders.delete(pane)
  }, [pane, scrollToHeading])

  useEffect(() => {
    if (focused) setState(outline)
  }, [focused, outline])

  useEffect(() => {
    const node = article.current?.parentElement
    if (!node) return
    const observer = new ResizeObserver(([item]) => setWidth(item.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Split view previews the draft as you type (debounced), instead of the file on disk.
  const mode = useLeaf((s) => s.editModes[path])
  const draftText = useLeaf((s) => s.drafts[path]?.text)
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (mode !== 'split' || draftText === undefined) return setPreview(null)
    const timer = setTimeout(() => setPreview(draftText), 250)
    return () => clearTimeout(timer)
  }, [mode, draftText])

  // Load and render whenever the document, its grant, the view mode, or the theme changes.
  const grantId = entry?.id
  const grantError = entry?.error
  const granted = entry !== undefined
  useEffect(() => {
    if (!granted) return // Grant not hydrated yet; the next sync supplies it.
    const run = ++sequence.current
    const stale = () => run !== sequence.current
    const controller = new AbortController()
    remember()
    setBusy(true)
    displayed.current = null
    ;(async () => {
      try {
        let text = preview
        if (text === null) {
          if (grantError || !grantId) throw new Error(grantError ?? 'File is unavailable.')
          const blob = await fetchFile(grantId, controller.signal)
          if (blob.size > 10 * 1024 * 1024) throw new Error('This file exceeds the 10 MB reading limit.')
          text = await blob.text()
        }
        if (stale()) return
        const extension = path.split('.').pop()?.toLowerCase() ?? ''
        const rendersMarkdown = (preview !== null || !source) && isMarkdown(path)
        const html = rendersMarkdown
            ? renderMarkdown(text)
            : `<pre><code class="language-${source ? 'markdown' : (CODE_LANGUAGE[extension] ?? 'plaintext')}">${escapeHTML(text)}</code></pre>`
        // Parse off-DOM so diagrams and images resolve before anything visible changes.
        const scratch = document.createElement('div')
        scratch.innerHTML = html
        const { headings, diagrams, codeBlocks } = enhance(scratch)
        for (const pre of scratch.querySelectorAll('pre')) {
          const language = [...(pre.querySelector('code')?.classList ?? [])].find((name) => name.startsWith('language-'))?.slice(9)
          const bar = document.createElement('div')
          bar.className = 'code-bar'
          if (language && language !== 'plaintext') {
            const label = document.createElement('span')
            label.className = 'code-language'
            label.textContent = language
            bar.append(label)
          }
          const copy = document.createElement('button')
          copy.type = 'button'
          copy.dataset.copy = ''
          copy.textContent = 'Copy'
          copy.className = 'code-copy'
          bar.append(copy)
          const wrap = document.createElement('div')
          wrap.className = 'code-block'
          pre.replaceWith(wrap)
          wrap.append(pre, bar)
        }
        const fresh: string[] = []
        await Promise.all([
          highlight(codeBlocks),
          ...[...scratch.querySelectorAll('img')].map(async (img) => {
            const reference = img.getAttribute('src') ?? ''
            img.removeAttribute('src')
            const target = /^[a-z][a-z0-9+.-]*:/i.test(reference) ? null : resolveRelative(reference.split('#')[0], path)
            const grant = target ? grants.current.get(target) : undefined
            if (!target || !/\.(png|jpe?g|gif|webp|avif)$/i.test(target)) {
              img.alt = img.alt || (target ? 'Unsupported image type' : 'Remote image not loaded')
              return
            }
            try {
              // Images in opened folders have their own grant; others load through the document's,
              // which reaches only its own folder and below.
              if (!grant?.id && !grantId) throw new Error('Document grant is unavailable')
              const blob = grant?.id ? await fetchFile(grant.id, controller.signal) : await fetchDocumentImage(grantId!, target, controller.signal)
              const url = URL.createObjectURL(blob)
              fresh.push(url)
              img.src = url
              await img.decode().catch(() => {})
              frameImage(img, path, reference)
            } catch {
              img.alt = img.alt || 'Image unavailable'
              img.title = "Image unavailable. Leaf shows images from the document's folder and its subfolders."
            }
          }),
        ])
        const results = await Promise.all(
          diagrams.map(async ({ mount, source: code }) => {
            try {
              const diagram = await renderDiagram(code, theme)
              fresh.push(diagram.url)
              return { mount, source: code, result: { diagram } as DiagramResult }
            } catch (error) {
              return { mount, source: code, result: { error: String((error as Error).message ?? error) } as DiagramResult }
            }
          }),
        )
        if (stale()) {
          fresh.forEach(URL.revokeObjectURL)
          return
        }
        urls.current.forEach(URL.revokeObjectURL)
        urls.current = fresh
        setFailure(null)
        setRendered({ path, text, code: !rendersMarkdown, html: scratch.innerHTML, stats: readingStats(text), diagrams: results })
        // Keep the live nodes: mounts are re-queried from the committed article below.
        setOutline({ headings, status: `${readingStats(text).words.toLocaleString()} words` })
      } catch (error) {
        if (stale() || controller.signal.aborted) return
        setRendered(null)
        setFailure({ path, message: (error as Error).message })
        setOutline({ headings: [], status: (error as Error).message })
        setBusy(false)
      }
    })()
    return () => {
      controller.abort()
      setBusy(false)
    }
  }, [path, granted, grantId, grantError, source, theme, remember, setBusy, updatedAt, preview])

  // Switching documents hides the old article, which clamps scrollTop to 0 and fires a scroll
  // event on the next frame. Forget the old document first so that event can't overwrite its
  // saved position (switching code paths record the position before the switch).
  useLayoutEffect(() => {
    if (displayed.current !== path) displayed.current = null
  }, [path])

  // Commit the rendered HTML, attach diagram portals, then restore the reading position.
  const [mounts, setMounts] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    const node = article.current
    if (!node || !rendered) return
    node.innerHTML = rendered.html
    setMounts([...node.querySelectorAll<HTMLElement>('.diagram')])
  }, [rendered])

  useLayoutEffect(() => {
    const node = article.current
    if (!rendered || !viewport.current || !node) return
    // Wait for this render's own diagram mounts; detached mounts belong to the previous document.
    if (mounts.length !== rendered.diagrams.length || !mounts.every((mount) => node.contains(mount))) return
    const hash = pendingHash.current
    pendingHash.current = null
    const target = hash ? article.current?.querySelector<HTMLElement>(`[id="${CSS.escape(hash)}"]`) : null
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' })
    else viewport.current.scrollTo({ top: scrolls.get(rendered.path) ?? 0, behavior: 'instant' })
    displayed.current = rendered.path
    setBusy(false)
    const code = node.querySelector<HTMLElement>('pre > code')
    // An open editor takes jumps to its own lines.
    const line = isTex(rendered.path) && !getState().editModes[rendered.path] ? takeLine(rendered.path) : undefined
    if (code && line) showLine(code, viewport.current, line)
  }, [mounts, rendered, setBusy])

  // A LaTeX source in the focused pane tells a live PDF which line it shows, so the PDF can follow.
  // With an editor open, its cursor does that instead.
  const editing = useLeaf((s) => !!s.editModes[path])
  // The source beside a PDF reports even without focus: the PDF pane is often the focused one.
  const besidePdf = useLeaf((s) => {
    const split = s.workspace ? currentSplit(s.workspace) : null
    return !!split && split.panes.includes(path) && split.panes.some((pane) => pane !== path && isPdf(pane))
  })
  useEffect(() => {
    const node = viewport.current
    if (!node || !(focused || besidePdf) || !isTex(path) || editing || rendered?.path !== path) return
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const code = article.current?.querySelector<HTMLElement>('pre > code')
        if (code && displayed.current === path) reportPosition(path, lineInView(code, node))
      })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      clearTimeout(timer)
      timer = setTimeout(report, 120)
    }
    report()
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      node.removeEventListener('scroll', onScroll)
    }
  }, [focused, besidePdf, path, editing, rendered])

  // A jump from the PDF or an error list to a line of this document, when it is already shown.
  useEffect(() => {
    const onGoto = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== path || displayed.current !== path || editing) return
      const code = article.current?.querySelector<HTMLElement>('pre > code')
      const line = takeLine(path)
      if (code && line && viewport.current) showLine(code, viewport.current, line)
    }
    window.addEventListener('leaf:goto-line', onGoto)
    return () => window.removeEventListener('leaf:goto-line', onGoto)
  }, [path, editing])

  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), [])

  useEffect(() => (article.current ? attachImageResize(article.current) : undefined), [])

  const onClick = (event: React.MouseEvent) => {
    const element = event.target as HTMLElement
    if (element.closest('[data-copy]')) {
      const button = element.closest<HTMLButtonElement>('[data-copy]')!
      const text = button.parentElement?.querySelector('code')?.textContent ?? ''
      navigator.clipboard.writeText(text).then(() => {
        button.textContent = 'Copied'
        setTimeout(() => (button.textContent = 'Copy'), 1200)
      })
      return
    }
    const link = element.closest('a')
    if (!link || !article.current?.contains(link)) return
    const href = link.getAttribute('href') ?? ''
    event.preventDefault()
    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
    } else if (href.startsWith('#')) {
      scrollToHeading(decodeURIComponent(href.slice(1)))
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      setState({ status: 'This link type is not supported.' })
    } else {
      const [relative, hash] = href.split('#')
      const target = resolveRelative(relative, path)
      if (!target || !DOCUMENT_FILE.test(target)) {
        setState({ status: 'Leaf opens linked text documents only.' })
        return
      }
      if (target === path) {
        if (hash) scrollToHeading(decodeURIComponent(hash))
        return
      }
      pendingHash.current = hash ? decodeURIComponent(hash) : null
      actions.open(target)
    }
  }

  const current = rendered?.path === path ? rendered : null
  const failed = failure?.path === path ? failure : null
  const loading = !current && !failed

  const draft = useLeaf((s) => s.drafts[path])
  // While a draft is open, follow the file on disk: reload a clean draft, hold changes for a dirty one.
  const hasDraft = !!draft
  const finding = useLeaf((s) => s.findOpen) && focused && !!current && mode !== 'edit'
  useEffect(() => {
    if (hasDraft && stamp && grantId) diskChanged(path, grantId).catch(() => {})
  }, [hasDraft, stamp, grantId, path])

  return (
    <div
      ref={viewport}
      onScroll={remember}
      onPointerDownCapture={() => !focused && actions.focus(path)}
      data-pane-focused={focused || undefined}
      className={cn(
        'print-flow @container relative min-h-0 flex-1 overflow-y-auto bg-paper [scrollbar-gutter:stable]',
      )}
    >
      {finding && <FindBar article={article} viewport={viewport} version={current} />}
      <div
        className={cn(
          'mx-auto flex gap-12 px-10 pt-10 pb-32 @max-[880px]:gap-6 @max-[880px]:px-6',
          mode === 'split' || prefs.width === 'full' ? 'max-w-none' : 'max-w-[1400px]',
        )}
      >
        {mode === 'split' && draft && (
          <div className="min-w-0 flex-1 border-r border-rule pr-10">
            <EditBar path={path} />
            <Editor key={path} path={path} text={draft.text} fontSize={prefs.fontSize} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="mx-auto"
            style={{ maxWidth: prefs.width === 'full' ? 'none' : prefs.fontSize * (prefs.width === 'wide' ? 58 : 42) }}
          >
            <DocumentHeader path={path} stats={current?.stats} source={source} updatedAt={updatedAt} />
            {isTex(path) && <TexBar path={path} />}
            {mode === 'edit' && draft && (
              <>
                <EditBar path={path} />
                <Editor key={path} path={path} text={draft.text} fontSize={prefs.fontSize} />
              </>
            )}
            {failed && (
              <div className="mt-6 rounded-[10px] border border-rule bg-chrome/50 px-5 py-4">
                <p className="font-medium text-ink">This document can't be shown</p>
                <p className="mt-1 text-sm text-ink-muted">{failed.message}</p>
                <p className="mt-3 text-sm text-ink-muted">
                  Restore the file at this path, then run <code className="font-mono text-[12px]">leaf refresh</code>.
                </p>
              </div>
            )}
            {loading && (
              <div aria-hidden className="mt-2 animate-in space-y-3 fill-mode-both delay-150 duration-300 fade-in-0">
                {[92, 100, 84, 96, 60].map((w, i) => (
                  <div key={i} className="h-3.5 animate-pulse rounded bg-chrome" style={{ width: `${w}%` }} />
                ))}
              </div>
            )}
            <article
              ref={article}
              onClick={onClick}
              data-font={prefs.font}
              data-source={source || undefined}
              style={{ '--body-size': `${prefs.fontSize}px`, '--measure': 'none' } as React.CSSProperties}
              className={loading || failed || mode === 'edit' ? 'hidden' : 'prose-leaf'}
            />
          </div>
        </div>
        {mode !== 'split' && (
          <SidePanel
            path={path}
            viewport={viewport}
            article={article}
            version={current}
            editing={mode === 'edit'}
            headings={outline.headings}
            onHeading={scrollToHeading}
          />
        )}
      </div>
      {current && <SelectionCommentButton path={path} article={article} />}
      {current &&
        mounts.map((mount, index) => {
          const item = current.diagrams[index]
          return item ? createPortal(<DiagramPanel source={item.source} result={item.result} available={width} />, mount, String(index)) : null
        })}
    </div>
  )
}
