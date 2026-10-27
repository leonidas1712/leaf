/*
 * Live LaTeX projects in the reader. The server builds; this module finds the project for a path,
 * carries source positions from the reading pane to the live PDF (so the PDF follows), and carries
 * jumps from the PDF back to a source line.
 */
import { toast } from 'sonner'
import { texAction, type TexProject } from './api'
import { actions, getState } from './store'

export const isTex = (path: string) => /\.tex$/i.test(path)

/** The project a source file belongs to, or whose live PDF this is; the deepest root wins. */
export function projectFor(path: string, projects: TexProject[] = getState().tex): TexProject | undefined {
  let best: TexProject | undefined
  for (const project of projects) {
    if (path === project.pdf || path.startsWith(project.root + '/')) {
      if (!best || project.root.length > best.root.length) best = project
    }
  }
  return best
}

export const isLivePdf = (path: string, projects: TexProject[] = getState().tex) => projects.some((p) => p.pdf === path)

/* ---------------------------------------------------------------- Source → PDF */

export interface SourcePosition {
  path: string
  /** The line at the top of the reading pane, or the editor's cursor line; null for the file's start. */
  line: number | null
}

const followers = new Set<(position: SourcePosition) => void>()
let lastPosition: SourcePosition | null = null

/** The focused source pane reports what it shows; a live PDF beside it scrolls there. */
export function reportPosition(path: string, line: number | null) {
  if (lastPosition?.path === path && lastPosition.line === line) return
  lastPosition = { path, line }
  followers.forEach((follow) => follow(lastPosition!))
}

export function onPosition(follow: (position: SourcePosition) => void) {
  followers.add(follow)
  return () => void followers.delete(follow)
}

export function currentPosition() {
  return lastPosition
}

/* ---------------------------------------------------------------- PDF → source */

const pendingLines = new Map<string, number>()

/** Show a source line: open or focus its tab (the PDF pane stays put), then scroll to it. */
export function gotoLine(path: string, line: number | null) {
  if (line) pendingLines.set(path, line)
  const ws = getState().workspace
  if (ws?.active !== path) {
    if (ws?.tabs.some((tab) => tab.path === path)) actions.focus(path)
    else actions.open(path)
  }
  window.dispatchEvent(new CustomEvent('leaf:goto-line', { detail: path }))
}

/** The line a pane should scroll to once it shows `path`, consumed on read. */
export function takeLine(path: string) {
  const line = pendingLines.get(path)
  pendingLines.delete(path)
  return line
}

/* ---------------------------------------------------------------- Build controls */

export async function recompile(path: string) {
  try {
    await texAction({ action: 'build', path })
  } catch (error) {
    toast.error((error as Error).message)
  }
}

export async function setAuto(path: string, auto: boolean) {
  try {
    await texAction({ action: 'auto', path, auto })
    toast(auto ? 'Auto-compile on: Leaf rebuilds when the sources settle.' : 'Auto-compile off: recompile with B or the Recompile button.')
  } catch (error) {
    toast.error((error as Error).message)
  }
}

/** Show the live PDF beside the current document. */
export function showPreview(project: TexProject) {
  if (!project.pdfExists) return toast('The PDF is still building.')
  return actions.split(project.pdf, 'right')
}

/** Register the project containing `path`, wait for its first build, and show the PDF beside it. */
export async function enableProject(path: string) {
  const working = toast.loading('Building the PDF…')
  try {
    const result = await texAction({ action: 'enable', path, wait: 300 })
    toast.dismiss(working)
    const project = result.project
    if (!project) return
    if (project.pdfExists) await showPreview(project)
    if (project.lastBuild && !project.lastBuild.ok)
      toast.error(`The build failed with ${project.lastBuild.errorCount} errors. The list is beside the source.`)
  } catch (error) {
    toast.dismiss(working)
    toast.error((error as Error).message)
  }
}
