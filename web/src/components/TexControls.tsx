import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, FileText, FileX, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TexIssue, TexProject } from '@/lib/api'
import { displayPath } from '@/lib/paths'
import { actions, currentSplit, useLeaf } from '@/lib/store'
import { gotoLine } from '@/lib/jump'
import { enableProject, projectFor, recompile, setAuto, showPreview } from '@/lib/tex'
import { cn } from '@/lib/utils'

function ago(seconds: number) {
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${Math.round(seconds)}s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

function useNow(interval = 10000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}

export type TexTone = 'good' | 'busy' | 'bad' | 'stale'

/** The color family of a project's state: busy (waiting or compiling), failed, out of date, or fine. */
export function texTone(project: TexProject): TexTone {
  if (project.state === 'building' || project.state === 'queued') return 'busy'
  if (project.state === 'failed') return 'bad'
  if (project.state === 'ok') return 'good'
  return 'stale'
}

/** A status bar's tint for its tone, plus a moving stripe along its bottom while busy, so it reads from the corner of the eye. */
export function TexToneBar({ project }: { project: TexProject }) {
  return texTone(project) === 'busy' ? <span aria-hidden className="tex-progress" /> : null
}

/** What the build is doing, in a few words, with a colored dot (a spinner while busy). */
export function TexStatus({ project }: { project: TexProject }) {
  const now = useNow()
  const build = project.lastBuild
  const [tone, label] = (() => {
    switch (project.state) {
      case 'building':
        return ['busy', 'Compiling…'] as const
      case 'queued':
        return ['busy', 'Edits coming in · compiling once they settle…'] as const
      case 'outdated':
        return ['stale', 'Sources changed · auto-compile off'] as const
      case 'failed':
        return ['bad', `Failed · ${build?.errorCount ?? 0} error${build?.errorCount === 1 ? '' : 's'}`] as const
      case 'ok':
        return ['good', `Compiled ${build ? ago(now / 1000 - build.finishedAt) : ''}`] as const
      default:
        return ['stale', 'Not compiled yet'] as const
    }
  })()
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1.5', tone !== 'good' && 'font-medium')}
      title={build ? `Last build took ${build.seconds}s with ${project.engine}` : undefined}
    >
      {tone === 'busy' ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <span
          className={cn('size-2 shrink-0 rounded-full', tone === 'good' && 'bg-leaf', tone === 'bad' && 'bg-destructive', tone === 'stale' && 'bg-(--g-orange)')}
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}

/** Recompile now, and switch automatic recompiling. */
export function TexActions({ project, compact = false }: { project: TexProject; compact?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="xs"
        className="text-ink-muted hover:text-ink"
        title="Recompile now (B)"
        disabled={project.building}
        onClick={() => recompile(project.root)}
      >
        <RefreshCw className={cn(project.building && 'animate-spin')} />
        {!compact && 'Recompile'}
      </Button>
      <button
        type="button"
        role="switch"
        aria-checked={project.auto}
        title={
          project.auto
            ? 'Auto-compile is on: Leaf rebuilds once edits settle. Click to pause.'
            : 'Auto-compile is off: the PDF waits for Recompile. Click to resume.'
        }
        onClick={() => setAuto(project.root, !project.auto)}
        className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-muted transition-colors hover:bg-accent hover:text-ink"
      >
        <span className={cn('relative h-3.5 w-6 rounded-full transition-colors', project.auto ? 'bg-leaf' : 'bg-rule-strong')}>
          <span className={cn('absolute top-0.5 size-2.5 rounded-full bg-paper shadow-sm transition-all', project.auto ? 'left-3' : 'left-0.5')} />
        </span>
        Auto
      </button>
    </span>
  )
}

function IssueRow({ issue, root, tone }: { issue: TexIssue; root: string; tone: 'error' | 'warning' }) {
  const where = issue.path ? (issue.path.startsWith(root + '/') ? issue.path.slice(root.length + 1) : displayPath(issue.path)) : null
  return (
    <li>
      <button
        type="button"
        disabled={!issue.path}
        onClick={() => issue.path && gotoLine(issue.path, issue.line)}
        className="flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className={cn('shrink-0 font-mono text-[11px]', tone === 'error' ? 'text-destructive' : 'text-ink-faint')}>
          {where ? `${where}${issue.line ? ':' + issue.line : ''}` : 'build'}
        </span>
        <span className="min-w-0 text-ink-muted">{issue.message}</span>
      </button>
    </li>
  )
}

const SHOWN = 8

function relativeTo(path: string | null, root: string) {
  if (!path) return 'build'
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

/** The last build's messages as Markdown an agent can act on: what failed, where, and how to check again. */
export function issuesMarkdown(project: TexProject, kind: 'errors' | 'warnings' | 'all' = 'all') {
  const build = project.lastBuild
  if (!build) return ''
  const line = (issue: TexIssue) => `- ${relativeTo(issue.path, project.root)}${issue.line ? ':' + issue.line : ''}: ${issue.message}`
  const warnings = [...build.warnings, ...build.boxes]
  const parts = [
    `LaTeX build of ${project.main} ${build.ok ? 'succeeded' : 'failed'} (${project.engine}, ${build.seconds}s). Paths are relative to ${project.root}.`,
  ]
  if (kind !== 'warnings' && !build.ok) parts.push(`\nErrors (${build.errorCount}):\n` + build.errors.map(line).join('\n'))
  if (kind !== 'errors' && warnings.length)
    parts.push(
      `\nWarnings (${build.warningCount + build.boxCount}${warnings.length < build.warningCount + build.boxCount ? `, first ${warnings.length}` : ''}):\n` +
        warnings.map(line).join('\n'),
    )
  if (build.log) parts.push(`\nFull log: ${build.log}`)
  parts.push(`Check again with: leaf tex build ${project.root}`)
  return parts.join('\n')
}

/** Copy build messages for an agent. */
export function CopyIssues({ project, kind, label }: { project: TexProject; kind: 'errors' | 'warnings' | 'all'; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title="Copy these messages, with file paths and lines, for an agent"
      onClick={(event) => {
        event.stopPropagation()
        navigator.clipboard.writeText(issuesMarkdown(project, kind)).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-faint transition-colors hover:bg-accent hover:text-ink"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : (label ?? 'Copy')}
    </button>
  )
}

/** A foldable list of messages; long lists show their first few until asked for all. */
function IssueGroup({
  project,
  issues,
  total,
  tone,
  initiallyOpen,
}: {
  project: TexProject
  issues: TexIssue[]
  total: number
  tone: 'error' | 'warning'
  initiallyOpen: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const [all, setAll] = useState(false)
  const shown = all ? issues : issues.slice(0, SHOWN)
  const noun = tone === 'error' ? 'error' : 'warning'
  return (
    <div>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            'flex flex-1 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent',
            tone === 'error' ? 'font-medium text-destructive' : 'text-ink-faint hover:text-ink',
          )}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {total} {noun}
          {total === 1 ? '' : 's'}
          {issues.length < total && <span className="font-normal text-ink-faint">({issues.length} listed)</span>}
        </button>
        <CopyIssues project={project} kind={tone === 'error' ? 'errors' : 'warnings'} />
      </div>
      {open && (
        <ul className="grid">
          {shown.map((issue, index) => (
            <IssueRow key={index} issue={issue} root={project.root} tone={tone} />
          ))}
          {issues.length > shown.length && (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="cursor-pointer px-2 py-1 text-ink-faint transition-colors hover:text-ink"
              >
                Show all {issues.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * The last build's errors (open) and warnings (folded), each foldable and copyable for an agent.
 * `only` limits both to one file.
 */
export function TexIssues({ project, only }: { project: TexProject; only?: string }) {
  const build = project.lastBuild
  if (!build) return null
  const errors = build.ok ? [] : build.errors.filter((issue) => !only || issue.path === only)
  const warnings = [...build.warnings, ...build.boxes].filter((issue) => !only || issue.path === only)
  if (!errors.length && !warnings.length) return null
  return (
    <div className="grid gap-0.5 text-[12px]">
      {errors.length > 0 && (
        <IssueGroup
          key={`errors-${build.finishedAt}`}
          project={project}
          issues={errors}
          total={only ? errors.length : build.errorCount}
          tone="error"
          initiallyOpen
        />
      )}
      {warnings.length > 0 && (
        <IssueGroup
          project={project}
          issues={warnings}
          total={only ? warnings.length : build.warningCount + build.boxCount}
          tone="warning"
          initiallyOpen={false}
        />
      )}
    </div>
  )
}

/**
 * Above a .tex source: the project's build state and controls, this file's errors, and a way to
 * show the live PDF. Outside a registered project it offers to set one up.
 */
export function TexBar({ path }: { path: string }) {
  const projects = useLeaf((s) => s.tex)
  const workspace = useLeaf((s) => s.workspace)
  const [asking, setAsking] = useState(false)
  const project = projectFor(path, projects)
  const split = workspace ? currentSplit(workspace) : null
  const shown = !!project && !!split?.panes.includes(project.pdf)

  if (!project) {
    return (
      <div className="print-hide mb-4 flex items-center justify-between gap-3 rounded-[10px] border border-rule px-3 py-2 text-[12.5px] text-ink-muted">
        <span>LaTeX source. Compile it to see the PDF beside it, updated as the files change.</span>
        <Button variant="ghost" size="xs" className="shrink-0 text-leaf-ink" onClick={() => setAsking(true)}>
          <FileText />
          Live PDF preview…
        </Button>
        <Dialog open={asking} onOpenChange={setAsking}>
          <DialogContent className="bg-chrome-raised shadow-float sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle className="text-[15px]">Compile this LaTeX project?</DialogTitle>
              <DialogDescription asChild>
                <div className="grid gap-2 text-[13px]">
                  <p>
                    Leaf will find the main file (the one with <code className="font-mono text-[12px]">\documentclass</code>
                    ), compile it with latexmk or tectonic, and show the PDF beside your sources. It recompiles once edits settle; you can pause that
                    any time.
                  </p>
                  <p>
                    Compiling runs the project's own build settings and TeX code, so only enable projects you trust. The output goes to Leaf's own
                    folder: your files, and any PDF your agents build, are not touched.
                  </p>
                  <p>
                    Agents can do the same with <code className="font-mono text-[12px] text-ink">leaf tex enable PATH</code>.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setAsking(false)
                  enableProject(path)
                }}
              >
                Compile and preview
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  return (
    <div className="print-hide mb-4 overflow-hidden rounded-[10px] border border-rule text-[12.5px] text-ink-muted">
      <div className={cn('relative flex items-center justify-between gap-3 px-3 py-1.5 transition-colors', `tex-tone-${texTone(project)}`)}>
        <TexToneBar project={project} />
        <TexStatus project={project} />
        <span className="flex shrink-0 items-center gap-1">
          {shown ? (
            <Button variant="ghost" size="xs" className="text-ink-muted hover:text-ink" title="Close the PDF pane and keep this source" onClick={() => actions.unsplit(path)}>
              <FileX />
              Hide PDF
            </Button>
          ) : (
            project.pdfExists && (
              <Button variant="ghost" size="xs" className="text-leaf-ink" title="Show the live PDF beside this source" onClick={() => showPreview(project)}>
                <FileText />
                Show PDF
              </Button>
            )
          )}
          <TexActions project={project} />
        </span>
      </div>
      {project.lastBuild && (
        <div className="border-t border-rule px-1 py-1 empty:hidden">
          <TexIssues project={project} only={path} />
        </div>
      )}
    </div>
  )
}
