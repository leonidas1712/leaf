import { useState, type RefObject } from 'react'
import { Bot, Check, CheckCheck, ClipboardCopy, Download, FileText, MessageSquarePlus } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isDocx, setState, useLeaf, type Heading } from '@/lib/store'
import { cn } from '@/lib/utils'
import { agentPrompt, CommentsRail, documentComments, exportComments, exportToWord, startComment } from './CommentsRail'
import { HistoryPanel } from './HistoryPanel'
import { Outline } from './Outline'

const SEGMENT =
  'h-6 gap-1.5 rounded-md px-2.5 text-[12px] text-ink-muted data-[state=on]:bg-paper data-[state=on]:text-ink data-[state=on]:shadow-xs dark:data-[state=on]:bg-rule-strong'

/** The right-hand column: the document's outline, its comment threads, or its version history. */
export function SidePanel({
  path,
  viewport,
  article,
  version,
  editing = false,
  headings,
  onHeading,
}: {
  path: string
  viewport: RefObject<HTMLDivElement | null>
  article: RefObject<HTMLElement | null>
  version: unknown
  editing?: boolean
  headings: Heading[]
  onHeading: (id: string) => boolean
}) {
  const open = useLeaf((s) => s.outlineOpen)
  const choice = useLeaf((s) => s.sidePanel)
  const all = useLeaf((s) => s.workspace?.comments)
  const drafting = useLeaf((s) => s.draft?.path === path)
  const [showResolved, setShowResolved] = useState(false)
  const [copied, setCopied] = useState(false)
  const comments = documentComments(all, path)
  const unresolved = comments.filter((c) => c.status !== 'resolved').length
  const resolved = comments.length - unresolved
  const mode = drafting ? 'comments' : choice === 'auto' ? (unresolved ? 'comments' : 'outline') : choice

  if (!open) return null

  const iconButton = (label: string, icon: React.ReactNode, onClick: () => void, pressed?: boolean) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            'grid size-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink',
            pressed && 'bg-accent text-ink',
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <aside
      aria-label="Document side panel"
      className="print-hide w-72 shrink-0 @max-[880px]:w-60 @max-[640px]:hidden"
    >
      <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center gap-1 bg-paper/95 px-2 pt-3 pb-3 backdrop-blur-sm">
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => value && setState({ sidePanel: value as 'outline' | 'comments' | 'history' })}
          className="rounded-lg bg-accent/60 p-0.5"
          aria-label="Side panel"
        >
          <ToggleGroupItem value="outline" className={SEGMENT}>
            Outline
          </ToggleGroupItem>
          <ToggleGroupItem value="comments" className={SEGMENT}>
            Comments
            {unresolved > 0 && (
              <span className="rounded-full bg-leaf px-1.5 text-[10.5px] leading-4 font-semibold text-primary-foreground tabular-nums">
                {unresolved}
              </span>
            )}
          </ToggleGroupItem>
          <ToggleGroupItem value="history" className={SEGMENT}>
            History
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === 'comments' && !editing && (
          <div className="ml-auto flex items-center">
            {iconButton('Comment on the whole document', <MessageSquarePlus className="size-4" />, () =>
              setState({ draft: { path, anchor: null }, activeComment: 'draft' }),
            )}
            {iconButton(copied ? 'Copied: paste it to your agent' : 'Copy prompt for an agent', copied ? <Check className="size-4 text-leaf" /> : <Bot className="size-4" />, () =>
              navigator.clipboard.writeText(agentPrompt(path)).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              }),
            )}
            {comments.length > 0 && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="Export comments"
                        className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink"
                      >
                        <Download className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Export comments</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="w-56">
                  {unresolved > 0 && (
                    <>
                      <DropdownMenuItem onSelect={() => exportComments(path, 'clipboard', true)}>
                        <ClipboardCopy /> Copy unresolved
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => exportComments(path, 'file', true)}>
                        <Download /> Download unresolved .md
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => exportComments(path, 'clipboard')}>
                    <ClipboardCopy /> Copy all (incl. resolved)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => exportComments(path, 'file')}>
                    <Download /> Download all .md
                  </DropdownMenuItem>
                  {isDocx(path) && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={!unresolved} onSelect={() => exportToWord(path)}>
                        <FileText /> Save copy with Word comments
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
        {mode === 'comments' && !editing && resolved > 0 && (
          // Labelled rather than an icon: resolved threads are otherwise easy to lose track of.
          <button
            type="button"
            aria-pressed={showResolved}
            onClick={() => setShowResolved((v) => !v)}
            className={cn(
              'mt-2 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-accent',
              showResolved ? 'text-ink' : 'text-ink-muted',
            )}
          >
            <CheckCheck className="size-3.5 text-leaf" />
            {resolved} resolved
            <span className="ml-auto font-medium text-leaf-ink">{showResolved ? 'Hide' : 'Show'}</span>
          </button>
        )}
      </div>
      {mode === 'outline' ? (
        <Outline viewport={viewport} headings={headings} onHeading={onHeading} />
      ) : mode === 'history' ? (
        <HistoryPanel path={path} />
      ) : editing ? (
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Comments sit beside the text in Read and Split views. Switch to one of those to see and add them.
        </p>
      ) : (
        <>
          <CommentsRail path={path} article={article} version={version} showResolved={showResolved} />
          {!comments.length && !drafting && (
            <button
              type="button"
              onClick={() => startComment(path, article.current)}
              className="w-full rounded-xl border border-dashed border-rule-strong px-3 py-4 text-left text-[12.5px] leading-relaxed text-ink-muted transition-colors hover:bg-chrome/50"
            >
              Select any text and press <span className="font-medium text-ink">Comment</span>, or press{' '}
              <kbd className="rounded border border-rule bg-chrome px-1 font-sans text-[11px]">c</kbd>. Agents read and resolve
              comments with <code className="font-mono text-[11.5px] text-ink">leaf comments</code>.
            </button>
          )}
        </>
      )}
    </aside>
  )
}
