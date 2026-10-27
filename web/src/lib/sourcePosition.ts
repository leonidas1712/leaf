/*
 * Find rendered text in a document's source, so the editor can open where the reader is. Mirrors
 * `normalized` in comments.py: whitespace collapses, and for Markdown the syntax that never renders
 * (emphasis marks, link destinations, heading and list markers, fences) is skipped, each kept
 * character remembering its offset in the source.
 */
import type { SourceRange } from './jump'

const MARKDOWN_SKIP = [
  /!?\[([^\]]+)\]\([^\n)]*\)/g,
  /<[^>\n]+>/g,
  /^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+\.\s+)/gm,
  /^\s*```[^\n]*/gm,
]

function normalized(source: string, markdown: boolean) {
  const skip = new Uint8Array(source.length)
  if (markdown) {
    for (const pattern of MARKDOWN_SKIP) {
      for (const match of source.matchAll(pattern)) {
        const start = match.index!
        // Keep a link's label; skip the brackets and destination around it.
        const label = match[1] !== undefined ? start + match[0].indexOf(match[1]) : -1
        for (let i = start; i < start + match[0].length; i++) if (label < 0 || i < label || i >= label + match[1].length) skip[i] = 1
      }
    }
  }
  const chars: string[] = []
  const offsets: number[] = []
  for (let i = 0; i < source.length; i++) {
    let char = source[i]
    if (skip[i] || (markdown && '*_`~'.includes(char))) continue
    if (/\s/.test(char)) {
      if (!chars.length || chars[chars.length - 1] === ' ') continue
      char = ' '
    }
    chars.push(char)
    offsets.push(i)
  }
  return { text: chars.join(''), offsets }
}

function occurrences(text: string, quote: string) {
  const found: number[] = []
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) found.push(at)
  return found
}

/**
 * The source range behind a rendered passage. Context breaks ties between repeats; a long passage
 * that no longer matches whole (edited, or spanning syntax) falls back to its opening words.
 */
export function findInSource(source: string, quote: string, markdown: boolean, prefix = '', suffix = ''): SourceRange | null {
  const wanted = quote.replace(/\s+/g, ' ').trim()
  if (!wanted) return null
  const views = markdown ? [normalized(source, true), normalized(source, false)] : [normalized(source, false)]
  const attempts = [wanted, ...(wanted.length > 48 ? [wanted.slice(0, 48)] : []), ...(wanted.length > 20 ? [wanted.slice(0, 20)] : [])]
  for (const attempt of attempts) {
    for (const { text, offsets } of views) {
      const matches = occurrences(text, attempt)
      if (!matches.length) continue
      const score = (at: number) =>
        Number(!!prefix && text.slice(0, at).trimEnd().endsWith(prefix.trim())) +
        Number(!!suffix && text.slice(at + attempt.length).trimStart().startsWith(suffix.trim()))
      const at = matches.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best), matches[0])
      const from = offsets[at]
      // The whole quote's end when it matched in full; otherwise just the opening words found.
      const to = offsets[at + attempt.length - 1] + 1
      return { from, to: attempt === wanted ? to : from }
    }
  }
  return null
}
