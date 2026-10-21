import { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { displayPath } from '@/lib/paths'
import { useLeaf } from '@/lib/store'
import { groupStyle } from './groups'

function ago(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

/**
 * The title block: where this document lives, which project it belongs to, where it came
 * from, and whether an agent just changed it. The document's own H1 stays the title.
 */
export function DocumentHeader({
  path,
  stats,
  source,
  updatedAt,
}: {
  path: string
  stats?: { words: number; minutes: number }
  source: boolean
  updatedAt: number | null
}) {
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const group = useLeaf((s) => {
    const id = s.workspace?.tabs.find((tab) => tab.path === path)?.group
    return id ? s.workspace?.groups?.find((g) => g.id === id) : undefined
  })
  const origin = useLeaf((s) => s.workspace?.sources?.[path])
  const shown = displayPath(path)
  const cut = shown.lastIndexOf('/')

  useEffect(() => {
    if (!updatedAt) return
    setNow(Date.now())
    const settle = setTimeout(() => setNow(Date.now()), 6100)
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => {
      clearTimeout(settle)
      clearInterval(timer)
    }
  }, [updatedAt])

  const copy = () =>
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })

  const fresh = updatedAt !== null && now - updatedAt < 6000

  return (
    <div className="print-hide mb-9 flex items-center gap-3 border-b border-rule pb-3 text-[12px] text-ink-muted">
      {group && (
        <span
          style={groupStyle(group.color)}
          className="shrink-0 rounded-md bg-[color-mix(in_oklch,var(--g)_16%,transparent)] px-1.5 py-px text-[11.5px] font-semibold text-[color-mix(in_oklch,var(--g)_75%,var(--ink))]"
        >
          {group.name}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            className="group/path flex min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left transition-colors hover:text-ink"
          >
            <span className="truncate">
              <span className="text-ink-faint">{shown.slice(0, cut + 1)}</span>
              <span className="font-medium text-ink-soft">{shown.slice(cut + 1)}</span>
            </span>
            {copied ? (
              <Check className="size-3.5 shrink-0 text-leaf" />
            ) : (
              <Copy className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/path:opacity-100" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? 'Copied path' : 'Copy full path for an agent'}</TooltipContent>
      </Tooltip>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 tabular-nums">
        {origin?.kind === 'aboard' && (
          <span title={[origin.server, origin.board, origin.file].filter(Boolean).join(' · ')}>
            Aboard{origin.board ? ` · ${origin.board}` : ''}
            {origin.version ? ` · v${origin.version}` : ''}
          </span>
        )}
        {updatedAt !== null && (
          <span
            className={
              fresh
                ? 'flex items-center gap-1 rounded-full bg-leaf-soft px-2 py-px font-medium text-leaf-ink transition-colors duration-700'
                : 'flex items-center gap-1 text-ink-muted transition-colors duration-700'
            }
          >
            <RefreshCw className="size-3" />
            Updated {ago(updatedAt, now)}
          </span>
        )}
        {source && <span className="rounded-full bg-chrome px-2 py-px text-[11px] font-medium text-ink-soft">Source</span>}
        {stats && (
          <span>
            {stats.words.toLocaleString()} words · {stats.minutes} min
          </span>
        )}
      </span>
    </div>
  )
}
