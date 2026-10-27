import { FileText, FolderPlus, FilePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { basename, displayPath } from '@/lib/paths'
import { actions, setState, DOCUMENT_FILE, useLeaf } from '@/lib/store'
import { LeafMark } from './LeafMark'

/** No tab open: teach the two ways in (ask an agent, or open a path) and offer recent work. */
export function EmptyState() {
  const workspace = useLeaf((s) => s.workspace)
  const recent = (workspace?.recentFiles ?? []).filter((path) => DOCUMENT_FILE.test(path)).slice(0, 6)

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="m-auto w-full max-w-[560px] px-8 py-16">
        <LeafMark className="mb-6 size-9 text-leaf" />
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">Nothing open</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">
          Ask any agent to put a document in front of you. Leaf keeps your tabs, folders, and reading positions
          between sessions.
        </p>
        <pre className="mt-6 overflow-x-auto rounded-[10px] border border-rule bg-code px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink">
          <span className="text-ink-faint">$ </span>leaf open ~/projects/atlas/PLAN.md{'\n'}
          <span className="text-ink-faint">$ </span>leaf open ~/projects/atlas/docs
        </pre>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button onClick={() => setState({ openDialog: 'open-file' })}>
            <FilePlus /> Open document
          </Button>
          <Button variant="outline" onClick={() => setState({ openDialog: 'open-folder' })}>
            <FolderPlus /> Add folder
          </Button>
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-faint">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd> for everything
          </span>
        </div>
        {recent.length > 0 && (
          <div className="mt-12">
            <h2 className="mb-2 text-[11px] font-medium text-ink-faint">Recently read</h2>
            <ul className="divide-y divide-rule border-y border-rule">
              {recent.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    onClick={() => actions.open(path)}
                    className="group/recent flex w-full items-center gap-3 py-2.5 text-left"
                  >
                    <FileText className="size-4 shrink-0 text-ink-faint group-hover/recent:text-leaf" />
                    <span className="truncate text-[13.5px] text-ink group-hover/recent:text-leaf-ink">{basename(path)}</span>
                    <span className="ml-auto truncate pl-4 text-[12px] text-ink-faint">
                      {displayPath(path.slice(0, path.lastIndexOf('/')))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
