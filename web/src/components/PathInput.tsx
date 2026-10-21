import { useEffect, useRef, useState } from 'react'
import { FileText, Folder } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { completePath, type Completion } from '@/lib/api'
import { basename } from '@/lib/paths'
import { cn } from '@/lib/utils'

/**
 * A path field that browses the disk as you type, so a document deep in a large repository
 * can be linked without adding the whole folder. ↑/↓ choose, Tab or Enter accepts; a folder
 * accepts into itself and keeps completing.
 */
export function PathInput({
  value,
  onChange,
  foldersOnly = false,
  invalid,
  label,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  foldersOnly?: boolean
  invalid?: boolean
  label: string
  placeholder: string
}) {
  const [items, setItems] = useState<Completion[]>([])
  const [index, setIndex] = useState(-1)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!/^[~/]/.test(value)) {
      setItems([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      completePath(value, controller.signal)
        .then((found) => {
          setItems(foldersOnly ? found.filter((item) => item.kind === 'dir') : found)
          setIndex(-1)
        })
        .catch(() => setItems([]))
    }, 90)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value, foldersOnly])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const accept = (item: Completion) => onChange(item.kind === 'dir' ? item.path.replace(/\/?$/, '/') : item.path)

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!items.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setIndex((current) => (current + step + items.length) % items.length)
    } else if ((event.key === 'Tab' || event.key === 'Enter') && (index >= 0 || (event.key === 'Tab' && items.length))) {
      // Enter with nothing highlighted falls through and submits the form.
      event.preventDefault()
      accept(items[Math.max(0, index)])
    } else if (event.key === 'Escape' && items.length) {
      event.stopPropagation()
      setItems([])
    }
  }

  return (
    <div className="relative">
      <Input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid}
        aria-autocomplete="list"
        aria-expanded={items.length > 0}
        spellCheck={false}
        autoComplete="off"
        className="h-10 bg-paper font-mono text-[13px]"
      />
      {items.length > 0 && (
        <div
          ref={list}
          role="listbox"
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-rule bg-paper p-1 shadow-float"
        >
          {items.map((item, i) => (
            <button
              key={item.path}
              type="button"
              role="option"
              aria-selected={i === index}
              data-highlighted={i === index}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(item)}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[12.5px] text-ink-soft',
                i === index && 'bg-accent text-ink',
              )}
            >
              {item.kind === 'dir' ? (
                <Folder className="size-3.5 shrink-0 text-ink-faint" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-leaf" />
              )}
              <span className="truncate">
                {basename(item.path.replace(/\/$/, ''))}
                {item.kind === 'dir' ? '/' : ''}
              </span>
            </button>
          ))}
          <p className="px-2 pt-1 pb-0.5 font-sans text-[11px] text-ink-faint">↑↓ choose · Tab accept · Enter open</p>
        </div>
      )}
    </div>
  )
}
