/*
 * Quote anchors over the rendered document. Text is indexed with whitespace collapsed, skipping
 * Leaf's own chrome (heading "#" links, code-block buttons, diagram panels), so the same passage
 * produces the same quote however the Markdown wraps. Resolution prefers an exact quote whose
 * context matches best, then falls back to the span between the old prefix and suffix (the passage
 * was edited), and otherwise reports the comment as detached. Comments are never dropped.
 */
import type { CommentAnchor } from './api'

const SKIP = '.heading-anchor, .code-bar, .diagram, button, script, style'
const CONTEXT = 32

export interface TextIndex {
  text: string
  nodes: Text[]
  /** For each character of `text`: which node, and the offset inside it. */
  nodeAt: Int32Array
  offsetAt: Int32Array
}

export function buildIndex(root: HTMLElement): TextIndex {
  const nodes: Text[] = []
  const chars: string[] = []
  const nodeAt: number[] = []
  const offsetAt: number[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  let space = true // collapse leading whitespace
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data
    const index = nodes.push(node) - 1
    for (let i = 0; i < value.length; i++) {
      const blank = /\s/.test(value[i])
      if (blank && space) continue
      chars.push(blank ? ' ' : value[i])
      nodeAt.push(index)
      offsetAt.push(i)
      space = blank
    }
  }
  return { text: chars.join(''), nodes, nodeAt: Int32Array.from(nodeAt), offsetAt: Int32Array.from(offsetAt) }
}

/** Index of the first indexed character at or after a DOM boundary point. */
function indexOf(index: TextIndex, container: Node, offset: number, root: HTMLElement): number {
  const probe = document.createRange()
  probe.setStart(root, 0)
  probe.setEnd(container, offset)
  // Count indexed characters that lie before the boundary.
  let low = 0
  let high = index.text.length
  while (low < high) {
    const mid = (low + high) >> 1
    const node = index.nodes[index.nodeAt[mid]]
    const position = probe.comparePoint(node, index.offsetAt[mid])
    if (position < 0 || (position === 0 && !(node === container && index.offsetAt[mid] >= offset))) low = mid + 1
    else high = mid
  }
  return low
}

function headingTrail(root: HTMLElement, at: Node): string | undefined {
  const trail: { level: number; text: string }[] = []
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (heading.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_PRECEDING) break
    const level = Number(heading.tagName[1])
    while (trail.length && trail.at(-1)!.level >= level) trail.pop()
    trail.push({ level, text: heading.textContent?.replace(/#$/, '').trim() ?? '' })
  }
  return trail.length ? trail.map((h) => h.text).join(' › ') : undefined
}

/** Describe a selection inside `root` as a quote anchor, or null when it selects nothing indexed. */
export function anchorFor(range: Range, root: HTMLElement, index: TextIndex): CommentAnchor | null {
  let start = indexOf(index, range.startContainer, range.startOffset, root)
  let end = indexOf(index, range.endContainer, range.endOffset, root)
  while (start < end && index.text[start] === ' ') start++
  while (end > start && index.text[end - 1] === ' ') end--
  if (end <= start) return null
  return {
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: index.text.slice(end, end + CONTEXT),
    heading: headingTrail(root, range.startContainer),
  }
}

export function rangeBetween(index: TextIndex, start: number, end: number): Range {
  const range = document.createRange()
  range.setStart(index.nodes[index.nodeAt[start]], index.offsetAt[start])
  range.setEnd(index.nodes[index.nodeAt[end - 1]], index.offsetAt[end - 1] + 1)
  return range
}

function sharedSuffix(a: string, b: string) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function sharedPrefix(a: string, b: string) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

export type Resolution =
  | { state: 'attached'; start: number; end: number }
  | { state: 'moved'; start: number; end: number } // quote edited; anchored by its old surroundings
  | { state: 'ambiguous' } // the quote appears several times and its context can't tell them apart
  | { state: 'detached' }

export function resolve(anchor: CommentAnchor, index: TextIndex): Resolution {
  const { text } = index
  let best: { start: number; score: number } | null = null
  let tied = false
  for (let at = text.indexOf(anchor.quote); at >= 0 && anchor.quote; at = text.indexOf(anchor.quote, at + 1)) {
    const score =
      sharedSuffix(text.slice(Math.max(0, at - CONTEXT), at), anchor.prefix) +
      sharedPrefix(text.slice(at + anchor.quote.length, at + anchor.quote.length + CONTEXT), anchor.suffix)
    if (best && score === best.score) tied = true
    if (!best || score > best.score) {
      best = { start: at, score }
      tied = false
    }
  }
  // Never highlight a guess: the agent CLI reports the same case as ambiguous.
  if (best && tied) return { state: 'ambiguous' }
  if (best) return { state: 'attached', start: best.start, end: best.start + anchor.quote.length }

  // The quote changed: if its old surroundings are still unique, anchor to what now sits between them.
  if (anchor.prefix.length >= 12 && anchor.suffix.length >= 12) {
    const before = text.indexOf(anchor.prefix)
    if (before >= 0 && text.indexOf(anchor.prefix, before + 1) < 0) {
      const start = before + anchor.prefix.length
      const end = text.indexOf(anchor.suffix, start)
      if (end > start && end - start <= anchor.quote.length * 3 + 200) return { state: 'moved', start, end }
    }
  }
  return { state: 'detached' }
}

/** Anchor for the current text selection inside `root`, null when nothing there is selected. */
export function selectionAnchor(root: HTMLElement | null): CommentAnchor | null {
  const selection = document.getSelection()
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  return root.contains(range.commonAncestorContainer) ? anchorFor(range, root, buildIndex(root)) : null
}
