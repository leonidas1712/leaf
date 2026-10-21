import { useEffect, useMemo, useState, type RefObject } from 'react'
import { reader, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'

/** Sticky contents for the open document; the current section follows the reading position. */
export function Outline({ viewport }: { viewport: RefObject<HTMLDivElement | null> }) {
  const headings = useLeaf((s) => s.headings)
  const open = useLeaf((s) => s.outlineOpen)
  const items = useMemo(() => headings.filter((heading) => heading.level <= 3), [headings])
  const top = Math.min(...items.map((heading) => heading.level))
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => {
    const node = viewport.current
    if (!node || !open || items.length < 2) return
    let frame = 0
    const update = () => {
      frame = 0
      const limit = node.getBoundingClientRect().top + 96
      let active = items[0]?.id ?? null
      for (const item of items) {
        const element = document.getElementById(item.id)
        if (element && element.getBoundingClientRect().top <= limit) active = item.id
        else if (element) break
      }
      // At the very bottom, the final section is the one being read.
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 4) active = items.at(-1)?.id ?? active
      setCurrent(active)
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

  if (!open) return null
  if (items.length < 2) return <div className="w-52 shrink-0 max-[1180px]:hidden" />

  return (
    <nav aria-label="On this page" className="print-hide w-52 shrink-0 max-[1180px]:hidden">
      <div className="sticky top-10 max-h-[calc(100vh-8rem)] overflow-y-auto pb-6">
        <p className="mb-3 text-[11px] font-medium text-ink-faint">On this page</p>
        <ul className="relative border-l border-rule">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => reader.scrollToHeading(item.id)}
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
