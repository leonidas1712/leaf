/* Markdown is parsed, then sanitized before it touches the DOM. Documents never run code. */
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Heading } from './store'

const MARKDOWN_FILE = /\.(md|markdown)$/i

export function isMarkdown(path: string) {
  return MARKDOWN_FILE.test(path)
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/

export function escapeHTML(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** YAML front matter becomes a quiet properties block instead of a stray rule and paragraph. */
function frontMatter(text: string): { html: string; body: string } {
  const match = FRONT_MATTER.exec(text)
  if (!match) return { html: '', body: text }
  const rows: [string, string][] = []
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (pair) rows.push([pair[1], pair[2]])
    else if (rows.length && line.trim()) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? ' ' : '') + line.trim().replace(/^- /, '· ')
  }
  if (!rows.length) return { html: '', body: text.slice(match[0].length) }
  const cells = rows
    .map(([key, value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value.replace(/^["']|["']$/g, '')) || '—'}</dd>`)
    .join('')
  return { html: `<dl class="front-matter">${cells}</dl>`, body: text.slice(match[0].length) }
}

export function renderMarkdown(text: string): string {
  const { html: properties, body } = frontMatter(text)
  const html = properties + (marked.parse(body, { gfm: true, async: false }) as string)
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'video', 'audio', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name'],
  })
}

const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i

export interface Enhanced {
  headings: Heading[]
  diagrams: { mount: HTMLElement; source: string }[]
  codeBlocks: HTMLElement[]
}

/** Give headings stable ids, convert GitHub alerts, and collect blocks the view upgrades. */
export function enhance(root: HTMLElement): Enhanced {
  for (const input of root.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove()
    else input.disabled = true
  }

  const slugs = new Map<string, number>()
  const headings: Heading[] = []
  for (const node of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const text = node.textContent?.trim() ?? ''
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section'
    const count = slugs.get(slug) ?? 0
    slugs.set(slug, count + 1)
    node.id = count ? `${slug}-${count}` : slug
    headings.push({ id: node.id, text, level: Number(node.tagName[1]) })
    const anchor = document.createElement('a')
    anchor.className = 'heading-anchor'
    anchor.href = '#' + node.id
    anchor.textContent = '#'
    anchor.setAttribute('aria-label', `Link to ${text}`)
    node.append(anchor)
  }

  for (const quote of root.querySelectorAll('blockquote')) {
    const first = quote.firstElementChild
    const match = first?.tagName === 'P' ? CALLOUT.exec(first.textContent ?? '') : null
    if (!first || !match) continue
    const kind = match[1].toLowerCase()
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode()
    if (textNode) textNode.textContent = (textNode.textContent ?? '').replace(CALLOUT, '')
    if (!first.textContent?.trim()) first.remove()
    const callout = document.createElement('div')
    callout.className = 'callout'
    callout.dataset.kind = kind
    const title = document.createElement('span')
    title.className = 'callout-title'
    title.textContent = kind
    callout.append(title, ...quote.childNodes)
    quote.replaceWith(callout)
  }

  const diagrams: Enhanced['diagrams'] = []
  const codeBlocks: HTMLElement[] = []
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    const pre = code.parentElement!
    if (code.classList.contains('language-mermaid')) {
      const mount = document.createElement('div')
      mount.className = 'diagram'
      pre.replaceWith(mount)
      diagrams.push({ mount, source: code.textContent ?? '' })
    } else {
      codeBlocks.push(code)
    }
  }
  return { headings, diagrams, codeBlocks }
}

/** Highlight code lazily; the highlighter is a separate chunk loaded on first use. */
export async function highlight(blocks: HTMLElement[]) {
  if (!blocks.length) return
  const { default: hljs } = await import('highlight.js/lib/common')
  for (const code of blocks) {
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9)
    if (language && !hljs.getLanguage(language)) continue
    if (!language && (code.textContent?.length ?? 0) > 20000) continue
    hljs.highlightElement(code)
  }
}

/** Resolve a document-relative reference against an absolute document path. */
export function resolveRelative(reference: string, documentPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    return null
  }
  if (decoded.startsWith('/')) return decoded
  const parts = documentPath.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (parts.length <= 1) return null
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

export function readingStats(text: string) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return { words, minutes: Math.max(1, Math.round(words / 230)) }
}
