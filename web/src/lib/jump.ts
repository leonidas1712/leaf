/*
 * Jumps to a place in a document, delivered to whichever view shows it next: the reader scrolls
 * to a line, the editor puts its cursor (or selection) there. Targets wait in a map until a view
 * takes them, because the view may not exist yet when the jump is requested.
 */
import { openEditor } from './drafts'
import { actions, getState } from './store'

/** A source range in the document's text: character offsets, `from` ≤ `to`. */
export interface SourceRange {
  from: number
  to: number
}

const pendingLines = new Map<string, number>()
const pendingRanges = new Map<string, SourceRange>()

function announce(path: string) {
  window.dispatchEvent(new CustomEvent('leaf:goto-line', { detail: path }))
}

async function show(path: string) {
  const ws = getState().workspace
  if (ws?.active === path) return
  if (ws?.tabs.some((tab) => tab.path === path)) await actions.focus(path)
  else await actions.open(path)
}

/** Show a source line: open or focus its tab (a PDF pane stays put), then scroll to it. */
export function gotoLine(path: string, line: number | null) {
  if (line) pendingLines.set(path, line)
  void show(path)
  announce(path)
}

/** The line a view should scroll to once it shows `path`, consumed on read. */
export function takeLine(path: string) {
  const line = pendingLines.get(path)
  pendingLines.delete(path)
  return line
}

/** The range an editor should select once it opens `path`, consumed on read. */
export function takeRange(path: string) {
  const range = pendingRanges.get(path)
  pendingRanges.delete(path)
  return range
}

/**
 * Open the editor with the cursor at `target`: a line, or a source range to select. The target is
 * set only once the editor mode is on, so the reading view never takes it first.
 */
export async function editAt(path: string, mode: 'edit' | 'split', target: { line: number } | SourceRange | null) {
  await show(path)
  if (!getState().editModes[path]) await openEditor(path, mode)
  if (!getState().editModes[path] || !target) return
  if ('line' in target) pendingLines.set(path, target.line)
  else pendingRanges.set(path, target)
  announce(path)
}
