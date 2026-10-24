import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useLeaf, type Heading } from '@/lib/store'
import { cn } from '@/lib/utils'

/**
 * Sticky contents for the pane's document; the current section follows the reading position.
 * Once the reader scrolls into the document it fades back so it doesn't compete with the text,
 * and returns at full strength on hover or keyboard focus.
 */
export function Outline({
  viewport,
  headings,
  onHeading,
}: {
  viewport: RefObject<HTMLDivElement | null>
  headings: Heading[]
  onHeading: (id: string) => boolean
}) {
  const open = useLeaf((s) => s.outlineOpen)
  const items = useMemo(() => headings.filter((heading) => heading.level <= 3), [headings])
  const top = Math.min(...items.map((heading) => heading.level))
  const [current, setCurrent] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = viewport.current
    if (!node || !open || items.length < 2) return
    let frame = 0
    const update = () => {
      frame = 0
      const limit = node.getBoundingClientRect().top + 96
      let active = items[0]?.id ?? null
      for (const item of items) {
        // Look within this pane: split documents can share heading ids.
        const element = node.querySelector<HTMLElement>(`[id="${CSS.escape(item.id)}"]`)
        if (element && element.getBoundingClientRect().top <= limit) active = item.id
        else if (element) break
      }
      // At the very bottom, the final section is the one being read.
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 4) active = items.at(-1)?.id ?? active
      setCurrent(active)
      setReading(node.scrollTop > 240)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    node.addEventListener('scroll', schedule, { passive: true })
    return () => {
      node.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }, [items, open, viewport])

  // A long outline scrolls on its own; keep the section being read visible in it.
  useEffect(() => {
    const box = list.current
    const item = box?.querySelector<HTMLElement>('[aria-current]')
    if (!box || !item) return
    const top = item.offsetTop - box.offsetTop
    if (top < box.scrollTop + 24 || top + item.offsetHeight > box.scrollTop + box.clientHeight - 24)
      box.scrollTo({ top: top - box.clientHeight / 2, behavior: 'smooth' })
  }, [current])

  if (!open) return null
  if (items.length < 2) return <p className="text-[12px] text-ink-faint">This document has no sections.</p>

  return (
    // Sticky on the nav itself: the side panel spans the whole document, the nav only its contents.
    <nav
      aria-label="On this page"
      className={cn(
        'print-hide sticky top-16 transition-opacity duration-500 hover:opacity-100 hover:duration-150 focus-within:opacity-100',
        reading ? 'opacity-30' : 'opacity-100',
      )}
    >
      <div ref={list} className="relative max-h-[calc(100vh-10rem)] overflow-y-auto pb-6">
        <ul className="relative border-l border-rule">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onHeading(item.id)}
                aria-current={current === item.id ? 'location' : undefined}
                style={{ paddingLeft: 12 + (item.level - top) * 12 }}
                className={cn(
                  '-ml-px block w-full border-l py-1 pr-2 text-left text-[12.5px] leading-snug transition-colors duration-150',
                  current === item.id
                    ? 'border-leaf font-medium text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                <span className="line-clamp-2">{item.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}
