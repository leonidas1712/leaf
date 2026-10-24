import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { buildIndex, rangeBetween, type TextIndex } from '@/lib/anchors'
import { getState, setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'

/** ⌘G / ⇧⌘G while the bar is open; set by the mounted bar. */
export const findControls: { step: ((direction: 1 | -1) => void) | null } = { step: null }

/** Open find in the focused pane, seeded with the selected text when there is a short selection. */
export function openFind() {
  const selected = document.getSelection()?.toString().trim() ?? ''
  const seed = selected && selected.length <= 200 && !selected.includes('\n') ? selected : null
  setState({ findOpen: true, findQuery: seed ?? getState().findQuery, findFocus: getState().findFocus + 1 })
}

export function closeFind() {
  setState({ findOpen: false })
}

/**
 * Find in the rendered document. Matches are painted with the CSS Custom Highlight API, so the
 * document's DOM is never changed; whitespace is collapsed and case ignored, as in the comment
 * anchors. The first match shown is the first one at or below the top of the view.
 */
export function FindBar({
  article,
  viewport,
  version,
}: {
  article: React.RefObject<HTMLElement | null>
  viewport: React.RefObject<HTMLDivElement | null>
  /** Changes whenever the article is re-rendered, so matches are recomputed. */
  version: unknown
}) {
  const query = useLeaf((s) => s.findQuery)
  const focusRequest = useLeaf((s) => s.findFocus)
  const input = useRef<HTMLInputElement>(null)
  const [index, setIndex] = useState<TextIndex | null>(null)
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    setIndex(article.current ? buildIndex(article.current) : null)
  }, [article, version])

  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusRequest])

  const needle = query.replace(/\s+/g, ' ').toLowerCase()
  const ranges = useMemo(() => {
    if (!index || !needle.trim()) return []
    const haystack = index.text.toLowerCase()
    const found: Range[] = []
    for (let at = haystack.indexOf(needle); at >= 0 && found.length < 5000; at = haystack.indexOf(needle, at + needle.length))
      found.push(rangeBetween(index, at, at + needle.length))
    return found
  }, [index, needle])

  // A new query or re-render starts from the first match in view, not the top of the document.
  useEffect(() => {
    const top = viewport.current?.getBoundingClientRect().top ?? 0
    const first = ranges.findIndex((range) => range.getBoundingClientRect().bottom > top)
    setCurrent(first < 0 ? 0 : first)
  }, [ranges, viewport])

  const selected = ranges[current]
  useEffect(() => {
    if (!('highlights' in CSS)) return
    CSS.highlights.set('leaf-find', new Highlight(...ranges))
    CSS.highlights.set('leaf-find-current', selected ? new Highlight(selected) : new Highlight())
    return () => {
      CSS.highlights.delete('leaf-find')
      CSS.highlights.delete('leaf-find-current')
    }
  }, [ranges, selected])

  // Bring the current match into view, centred, only when it is off screen.
  useEffect(() => {
    const view = viewport.current
    if (!selected || !view) return
    const box = view.getBoundingClientRect()
    const rect = selected.getBoundingClientRect()
    if (rect.top >= box.top + 56 && rect.bottom <= box.bottom - 24) return
    view.scrollTo({ top: view.scrollTop + rect.top - box.top - box.height / 2, behavior: 'instant' })
  }, [selected, viewport])

  const step = (direction: 1 | -1) => {
    if (ranges.length) setCurrent((value) => (value + direction + ranges.length) % ranges.length)
  }
  useEffect(() => {
    findControls.step = step
    return () => void (findControls.step = null)
  })

  return (
    <div className="print-hide sticky top-0 z-40 h-0">
      <div
        role="search"
        className="absolute top-3 right-5 flex h-9 animate-in items-center gap-1 rounded-lg border border-rule bg-paper pr-1 pl-3 shadow-md duration-150 fade-in-0 slide-in-from-top-1"
      >
        <input
          ref={input}
          value={query}
          onChange={(event) => setState({ findQuery: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              closeFind()
            }
          }}
          placeholder="Find in document"
          aria-label="Find in document"
          spellCheck={false}
          className="w-48 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
        <span
          aria-live="polite"
          className={cn('min-w-14 text-right text-[11.5px] tabular-nums', needle.trim() && !ranges.length ? 'text-destructive' : 'text-ink-faint')}
        >
          {needle.trim() ? (ranges.length ? `${current + 1} of ${ranges.length}` : 'No results') : ''}
        </span>
        <span className="mx-1 h-4 w-px bg-rule" />
        {[
          { label: 'Previous match (⇧Enter)', icon: ChevronUp, direction: -1 as const },
          { label: 'Next match (Enter)', icon: ChevronDown, direction: 1 as const },
        ].map(({ label, icon: Icon, direction }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            disabled={!ranges.length}
            onClick={() => step(direction)}
            className="grid size-7 place-items-center rounded-md text-ink-muted hover:bg-chrome hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Icon className="size-4" />
          </button>
        ))}
        <button
          type="button"
          title="Close (Esc)"
          aria-label="Close find"
          onClick={closeFind}
          className="grid size-7 place-items-center rounded-md text-ink-muted hover:bg-chrome hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
