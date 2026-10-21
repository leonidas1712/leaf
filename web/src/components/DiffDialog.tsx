import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { displayPath } from '@/lib/paths'
import { setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { diffLines, type DiffLine } from '@/lib/versions'

const CONTEXT = 3

type Row = DiffLine | { kind: 'gap'; count: number; key: number }

/** Unchanged runs longer than a few lines collapse into an expandable gap. */
function fold(lines: DiffLine[], expanded: Set<number>): Row[] {
  const rows: Row[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind !== 'same') {
      rows.push(lines[i++])
      continue
    }
    let j = i
    while (j < lines.length && lines[j].kind === 'same') j++
    const head = i === 0 ? 0 : CONTEXT
    const tail = j === lines.length ? 0 : CONTEXT
    if (j - i > head + tail + 2 && !expanded.has(i)) {
      rows.push(...lines.slice(i, i + head), { kind: 'gap', count: j - i - head - tail, key: i }, ...lines.slice(j - tail, j))
    } else rows.push(...lines.slice(i, j))
    i = j
  }
  return rows
}

export function DiffDialog() {
  const diff = useLeaf((s) => s.diff)
  const [expanded, setExpanded] = useState(new Set<number>())
  const lines = useMemo(() => (diff ? diffLines(diff.before, diff.after) : []), [diff])
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'remove').length
  const rows = fold(lines, expanded)

  return (
    <Dialog
      open={!!diff}
      onOpenChange={(open) => {
        if (open) return
        setState({ diff: null })
        setExpanded(new Set())
      }}
    >
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_1fr] gap-3 bg-chrome-raised p-0 shadow-float sm:max-w-[min(1000px,92vw)]">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-[15px]">{diff?.title}</DialogTitle>
          <DialogDescription className="flex gap-3 text-[12.5px]">
            <span className="truncate">{diff && displayPath(diff.path)}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              <span className="text-[var(--g-green)]">+{added}</span> <span className="text-[var(--g-red)]">−{removed}</span>
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-auto border-t border-rule bg-paper font-mono text-[12.5px] leading-[1.6]">
          {!added && !removed && <p className="p-5 font-sans text-[13px] text-ink-muted">No differences.</p>}
          {(added > 0 || removed > 0) &&
            rows.map((row, index) =>
              row.kind === 'gap' ? (
                <button
                  key={'gap' + row.key}
                  type="button"
                  onClick={() => setExpanded(new Set([...expanded, row.key]))}
                  className="block w-full bg-chrome/60 px-4 py-1 text-left font-sans text-[11.5px] text-ink-muted hover:bg-accent"
                >
                  ⋯ {row.count} unchanged lines
                </button>
              ) : (
                <div
                  key={index}
                  className={cn(
                    'grid grid-cols-[3.2rem_3.2rem_1.2rem_1fr] whitespace-pre-wrap',
                    row.kind === 'add' && 'bg-[color-mix(in_oklch,var(--g-green)_14%,transparent)]',
                    row.kind === 'remove' && 'bg-[color-mix(in_oklch,var(--g-red)_14%,transparent)]',
                  )}
                >
                  <span className="pr-2 text-right text-ink-faint select-none">{row.old ?? ''}</span>
                  <span className="pr-2 text-right text-ink-faint select-none">{row.new ?? ''}</span>
                  <span className="text-ink-faint select-none">{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''}</span>
                  <span className={cn('pr-4 break-words', row.kind === 'same' ? 'text-ink-muted' : 'text-ink')}>{row.text || ' '}</span>
                </div>
              ),
            )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
