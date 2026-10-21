import { useEffect, useState } from 'react'
import { Bot, CircleDot, FileClock, PenLine, RotateCcw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { isDirty } from '@/lib/drafts'
import { act, AUTHOR, getState, setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'
import { listVersions, versionText, type Version, type VersionList } from '@/lib/versions'
import { authorName } from './CommentCard'

const KIND: Record<Version['kind'], { label: string; icon: typeof Save }> = {
  save: { label: 'saved', icon: Save },
  checkin: { label: 'checked in', icon: Bot },
  external: { label: 'changed on disk', icon: PenLine },
  restore: { label: 'restored', icon: RotateCcw },
}

/** The oldest version is when Leaf first saw the file, not an edit. */
const FIRST = { label: 'first seen by Leaf', icon: FileClock }

function when(at: string) {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return today ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

/**
 * The versions Leaf has seen of this document, newest first: saves from the editor, agents'
 * check-ins with their notes, and changes Leaf noticed on disk without a name attached.
 */
export function HistoryPanel({ path }: { path: string }) {
  const stamp = useLeaf((s) => s.stamps[path])
  const [list, setList] = useState<VersionList | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listVersions(path)
      .then((next) => alive && (setList(next), setError('')))
      .catch((failure: Error) => alive && setError(failure.message))
    return () => {
      alive = false
    }
  }, [path, stamp])

  const compare = async (version: Version, index: number) => {
    setSelected(version.id)
    const previous = list?.versions[index + 1]
    try {
      const [after, before] = await Promise.all([versionText(path, version.id), previous ? versionText(path, previous.id) : ''])
      const who = version.author ? authorName(version.author) : 'Unsigned change'
      setState({ diff: { path, title: `${version.id} · ${who} · ${when(version.at)}`, before, after } })
    } catch (failure) {
      toast.error((failure as Error).message)
    }
  }

  const restore = async (version: Version) => {
    if (isDirty(getState().drafts[path])) {
      toast('Save or discard your edits first.')
      return
    }
    if (!list) return
    const failed = await act({ action: 'restore', path, version: version.id, base: list.current.hash, author: AUTHOR })
    if (!failed) toast.success(`Restored ${version.id} as a new version.`)
  }

  if (error) return <p className="text-[12px] text-ink-muted">{error}</p>
  if (!list) return <p className="text-[12px] text-ink-faint">Loading history…</p>
  if (!list.versions.length)
    return (
      <p className="flex gap-2 text-[12px] leading-relaxed text-ink-muted">
        <FileClock className="mt-0.5 size-3.5 shrink-0" />
        No versions yet. Leaf records a version when you save, when an agent runs <code className="font-mono text-ink">leaf checkin</code>,
        and when it notices the file changed.
      </p>
    )

  return (
    <div className="grid gap-1 pb-6">
      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-faint">
        Versions Leaf has seen. Agents sign theirs with <code className="font-mono">leaf checkin -m</code>; changes nobody
        signed show as "changed on disk". Select one to see what changed.
      </p>
      <ol className="relative grid gap-0.5 border-l border-rule pl-3">
        {list.versions.map((version, index) => {
          const kind = index === list.versions.length - 1 && version.kind === 'external' ? FIRST : KIND[version.kind]
          const current = version.hash === list.current.hash && index === 0
          return (
            <li key={version.id} className="group/version relative">
              <span
                className={cn(
                  'absolute top-3 -left-[17px] size-2 rounded-full border-2 border-paper',
                  current ? 'bg-leaf' : 'bg-rule-strong',
                )}
              />
              <button
                type="button"
                onClick={() => compare(version, index)}
                className={cn(
                  'grid w-full gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent',
                  selected === version.id && 'bg-accent',
                )}
              >
                <span className="flex items-center gap-1.5 text-[12.5px]">
                  <kind.icon className="size-3.5 shrink-0 text-ink-faint" />
                  {version.author ? (
                    <>
                      <span className="font-medium text-ink">{authorName(version.author)}</span>
                      <span className="text-ink-muted">{kind.label}</span>
                    </>
                  ) : (
                    <span className="text-ink-soft">{kind.label.charAt(0).toUpperCase() + kind.label.slice(1)}</span>
                  )}
                  <span className="ml-auto text-[11px] text-ink-faint tabular-nums">{when(version.at)}</span>
                </span>
                {version.note && <span className="pl-5 text-[12.5px] leading-snug text-ink-soft">{version.note}</span>}
                <span className="flex items-center gap-2 pl-5 text-[11px] text-ink-faint tabular-nums">
                  {version.id}
                  {(version.added || version.removed) && (
                    <span>
                      <span className="text-[var(--g-green)]">+{version.added ?? 0}</span>{' '}
                      <span className="text-[var(--g-red)]">−{version.removed ?? 0}</span>
                    </span>
                  )}
                  {current && <span className="rounded bg-leaf-soft px-1 text-leaf-ink">current</span>}
                  {version.base && (
                    <span className="flex items-center gap-0.5" title="An agent's checkout started from this version">
                      <CircleDot className="size-3" /> checkout base
                    </span>
                  )}
                </span>
              </button>
              {!current && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => restore(version)}
                  className="absolute top-1 right-1 hidden bg-chrome-raised text-ink-muted group-hover/version:inline-flex"
                >
                  <RotateCcw /> Restore
                </Button>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
