import { useState } from 'react'
import { Code2, Maximize2, Minus, Plus, Scan } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Diagram } from '@/lib/mermaid'
import { cn } from '@/lib/utils'

export type DiagramResult = { diagram: Diagram } | { error: string }

/** A rendered Mermaid figure with zoom, fit and source; failures keep the source readable. */
export function DiagramPanel({ source, result, available }: { source: string; result: DiagramResult; available: number }) {
  const natural = 'diagram' in result ? result.diagram.width : 0
  const fit = Math.min(natural, Math.max(240, available - 34))
  const [width, setWidth] = useState(fit)
  const [showSource, setShowSource] = useState('error' in result)

  const control = (label: string, icon: React.ReactNode, onClick: () => void, pressed?: boolean) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn('text-ink-muted hover:text-ink', pressed && 'bg-accent text-ink')}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <figure className="not-prose group/diagram overflow-hidden rounded-[10px] border border-rule bg-paper">
      <div className="flex h-9 items-center gap-0.5 border-b border-rule bg-chrome/60 pr-1.5 pl-3">
        <figcaption className="mr-auto font-sans text-[11px] font-medium tracking-wide text-ink-muted">
          {'error' in result ? 'Diagram could not render' : 'Diagram'}
        </figcaption>
        {'diagram' in result && (
          <>
            <span className="mr-1 font-mono text-[11px] text-ink-faint tabular-nums">
              {Math.round((width / natural) * 100)}%
            </span>
            {control('Zoom out', <Minus />, () => setWidth((w) => Math.max(120, w / 1.25)))}
            {control('Zoom in', <Plus />, () => setWidth((w) => Math.min(8000, w * 1.25)))}
            {control('Fit to width', <Scan />, () => setWidth(fit))}
            {control('Actual size', <Maximize2 />, () => setWidth(natural))}
          </>
        )}
        {control('Diagram source', <Code2 />, () => setShowSource((v) => !v), showSource)}
      </div>
      {'diagram' in result ? (
        <div className="max-h-[78vh] overflow-auto px-4 py-5">
          <img
            src={result.diagram.url}
            alt="Mermaid diagram"
            width={width}
            height={(result.diagram.height / natural) * width}
            className="mx-auto block max-w-none rounded-none"
            style={{ width }}
          />
        </div>
      ) : (
        <p className="px-4 py-3 font-sans text-sm text-destructive">{result.error}</p>
      )}
      {showSource && (
        <pre className="m-0! rounded-none! border-0! border-t! border-rule! text-[12px]!">
          <code>{source}</code>
        </pre>
      )}
    </figure>
  )
}
