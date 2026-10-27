import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { actions, currentSplit, DEFAULT_READER, isPdf, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { DocumentView } from './DocumentView'
import { PdfView } from './PdfView'

const clamp = (ratio: number) => Math.min(0.8, Math.max(0.2, ratio))

/**
 * The reading area: one document, or a split of two shown side by side (columns) or stacked
 * (rows). Panes keep their position as focus moves, so a pane's view is never remounted by a
 * focus change; dragging the divider resizes locally and saves the ratio on release.
 */
export function Panes({ theme }: { theme: 'light' | 'dark' }) {
  const workspace = useLeaf((s) => s.workspace)!
  const entries = useLeaf((s) => s.entries)
  const stamps = useLeaf((s) => s.stamps)
  const split = currentSplit(workspace)
  const container = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const columns = split?.layout !== 'rows'
  const ratio = dragging ?? split?.ratio ?? 1
  const panes = split ? split.panes : [workspace.active!]

  const ratioAt = (event: React.PointerEvent) => {
    const box = container.current!.getBoundingClientRect()
    return clamp(columns ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height)
  }

  const nudge = (event: React.KeyboardEvent) => {
    const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[event.key]
    if (!split || step === undefined) return
    event.preventDefault()
    actions.splitResize(Math.round(clamp(split.ratio + step) * 100) / 100)
  }

  return (
    <div ref={container} className={cn('flex min-h-0 flex-1', columns ? 'flex-row' : 'flex-col')}>
      {panes.map((path, index) => {
        const focused = !split || split.focus === index
        return [
          index === 1 && (
            <div
              key="divider"
              role="separator"
              aria-label="Resize split"
              aria-orientation={columns ? 'vertical' : 'horizontal'}
              aria-valuenow={Math.round(ratio * 100)}
              aria-valuemin={20}
              aria-valuemax={80}
              tabIndex={0}
              title="Drag to resize; double-click to even out"
              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                setDragging(ratioAt(event))
              }}
              onPointerMove={(event) => dragging !== null && setDragging(ratioAt(event))}
              onPointerUp={(event) => {
                if (dragging === null) return
                const final = Math.round(ratioAt(event) * 100) / 100
                setDragging(null)
                if (final !== split?.ratio) actions.splitResize(final)
              }}
              onLostPointerCapture={() => setDragging(null)}
              onDoubleClick={() => actions.splitResize(0.5)}
              onKeyDown={nudge}
              className={cn(
                'group/divider print-hide relative z-30 shrink-0 bg-rule transition-colors hover:bg-leaf/60 focus-visible:bg-leaf focus-visible:outline-none',
                dragging !== null && 'bg-leaf',
                columns
                  ? 'w-px cursor-col-resize after:absolute after:inset-y-0 after:-inset-x-1.5'
                  : 'h-px cursor-row-resize after:absolute after:inset-x-0 after:-inset-y-1.5',
              )}
            >
              {/* Shown while the divider is hovered: closes the split, keeping the focused pane. */}
              <button
                type="button"
                aria-label="Close split"
                title="Close split (|)"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => actions.unsplit()}
                className={cn(
                  'absolute top-1/2 left-1/2 z-10 grid size-6 -translate-1/2 cursor-pointer place-items-center rounded-full border border-rule bg-paper text-ink-muted opacity-0 shadow-sm transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/divider:opacity-100 group-focus-visible/divider:opacity-100',
                  dragging !== null && 'invisible',
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ),
          <div
            key={index === 0 ? 'first' : 'second'}
            className="relative flex min-h-0 min-w-0 flex-col"
            style={{ flex: `${index === 0 ? ratio : 1 - ratio} 1 0` }}
          >
            {split && (
              // Marks the focused pane: the one tabs, shortcuts, and agents' live commands act on.
              <div aria-hidden className={cn('print-hide h-0.5 shrink-0 transition-colors', focused ? 'bg-leaf' : 'bg-transparent')} />
            )}
            {isPdf(path) ? (
              <PdfView path={path} entry={entries.get(path)} stamp={stamps[path]} focused={focused} />
            ) : (
              <DocumentView
                path={path}
                entry={entries.get(path)}
                source={workspace.source}
                theme={theme}
                entries={entries}
                stamp={stamps[path]}
                prefs={workspace.reader ?? DEFAULT_READER}
                focused={focused}
              />
            )}
          </div>,
        ]
      })}
    </div>
  )
}
