/*
 * Word documents, rendered read-only as pages of HTML. docx-preview lays the document out with its
 * own styles, fonts, tables, images, headers, footers and footnotes; the result is ordinary text in
 * the reading pane, so quote-anchored comments, find, and the outline work as they do for Markdown.
 * Page breaks fall where the document asks for them, not where Word's layout would put them.
 */
import DOMPurify from 'dompurify'
import type { Heading } from './store'

export { isDocx } from './store'

/** Word files are zipped and carry their images, so they read under a larger limit than text. */
export const DOCX_LIMIT = 50 * 1024 * 1024

let renders = 0

/*
 * Office fonts such as Calibri, Aptos and Cambria are usually missing outside Office, and a family
 * with no fallback renders in the browser's default serif. Each family gets a generic fallback of
 * its kind, so Calibri reads as a sans-serif, Cambria as a serif.
 */
const SERIF = /times|georgia|cambria|garamond|book|palatino|baskerville|minion|serif|constantia|didot/i
const MONO = /courier|consolas|mono|menlo|lucida console/i

function withFallback(family: string) {
  const value = family.trim()
  if (!value || /^var\(|(?:^|,)\s*(?:serif|sans-serif|monospace|inherit|initial)\s*$/i.test(value)) return value
  return `${value}, ${MONO.test(value) ? 'monospace' : SERIF.test(value) ? 'serif' : 'sans-serif'}`
}

/** Bullets Word draws from Symbol and Wingdings code points, which other fonts leave blank. */
const SYMBOLS: Record<string, string> = {
  '\uf0b7': '•',
  '\uf0a7': '▪',
  '\uf0d8': '➢',
  '\uf076': '❖',
  '\uf0fc': '✓',
  '\uf0a8': '◦',
  '\uf06e': '■',
  '\uf071': '❑',
}
const PRIVATE_USE = /[\uf020-\uf0ff]/g
const symbol = (text: string) => text.replace(PRIVATE_USE, (char) => SYMBOLS[char] ?? '•')

function readableCss(css: string) {
  return symbol(css)
    .replace(/(font-family:\s*)([^;}\n]+)/g, (_, key: string, value: string) => key + withFallback(value))
    .replace(/(--[\w-]+-font:\s*)([^;}\n]+)/g, (_, key: string, value: string) => key + withFallback(value))
}

interface Style {
  id?: string | null
  name?: string | null
  cssName?: string
  paragraphProps?: { outlineLevel?: number }
}

/** Heading level of a paragraph style: its outline level, else a "Heading N" or "Title" name. */
function headingLevel(style: Style) {
  const outline = style.paragraphProps?.outlineLevel
  if (typeof outline === 'number' && outline >= 0 && outline < 6) return outline + 1
  const name = style.name ?? style.id ?? ''
  const numbered = /^heading\s*([1-6])$/i.exec(name)
  if (numbered) return Number(numbered[1])
  return /^title$/i.test(name) ? 1 : null
}

interface Paragraph {
  type: string
  numbering?: { id: string; level: number }
  children?: Paragraph[]
}

/**
 * Word numbers a list by its shared definition (abstractNum): list instances (num) that share one
 * continue a single count, and an instance with a start override restarts it. docx-preview counts
 * each instance on its own, so a list Word or LibreOffice split across instances restarts at 1.
 * Point each numbered paragraph at the instance whose count it continues.
 */
async function continueLists(parsed: any) {
  const part = parsed?.numberingPart
  const xml: string | undefined = part && (await part._package?.load(part.path))
  if (!xml) return
  const root = new DOMParser().parseFromString(xml, 'application/xml')
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const shared = new Map<string, string>()
  const restarts = new Map<string, Set<number>>()
  for (const num of root.getElementsByTagNameNS(W, 'num')) {
    const id = num.getAttributeNS(W, 'numId')
    const abstract = num.getElementsByTagNameNS(W, 'abstractNumId')[0]
    if (!id || !abstract) continue
    shared.set(id, abstract.getAttributeNS(W, 'val') ?? '')
    const levels = new Set<number>()
    for (const override of num.getElementsByTagNameNS(W, 'lvlOverride'))
      if (override.getElementsByTagNameNS(W, 'startOverride').length) levels.add(Number(override.getAttributeNS(W, 'ilvl')))
    restarts.set(id, levels)
  }
  const current = new Map<string, string>()
  const visit = (node: Paragraph) => {
    const numbering = node.type === 'paragraph' ? node.numbering : undefined
    const abstract = numbering && shared.get(numbering.id)
    if (numbering && abstract !== undefined) {
      const continuing = current.get(abstract)
      if (!continuing || (continuing !== numbering.id && restarts.get(numbering.id)?.has(numbering.level))) current.set(abstract, numbering.id)
      else numbering.id = continuing
    }
    node.children?.forEach(visit)
  }
  visit(parsed.documentPart?.body ?? {})
}

/**
 * Render a Word document into `into`, replacing its contents. Returns the headings for the outline;
 * heading paragraphs get an id and `data-heading`, since Word headings stay styled paragraphs.
 */
export async function renderDocx(blob: Blob, into: HTMLElement): Promise<Heading[]> {
  const { defaultOptions, parseAsync, renderDocument } = await import('docx-preview')
  // Each render gets its own class prefix: the generated CSS is page-wide, and two documents in a
  // split would otherwise restyle each other's paragraphs and list numbers.
  const className = `docx${++renders}`
  const options = {
    className,
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    // Embedded HTML chunks would render in an iframe; tracked changes and Word comments stay hidden.
    renderAltChunks: false,
    renderChanges: false,
    renderComments: false,
    // Data URLs survive copying the rendered HTML; object URLs would need revoking per render.
    useBase64URL: true,
    experimental: true,
    // Footnote numbers restart on each rendered page, so comment quotes leave them out; the agent's
    // view of the text (docx_text.py) has no numbers to match.
    h: (spec: Parameters<typeof defaultOptions.h>[0]) => {
      const node = defaultOptions.h(spec)
      const generated = typeof spec === 'object' && !(spec instanceof Node) && spec.tagName === 'sup'
      if (generated && spec.children?.length === 1 && typeof spec.children[0] === 'string') (node as HTMLElement).dataset.leafSkip = ''
      return node
    },
  }
  const parsed = await parseAsync(blob, options)
  await continueLists(parsed).catch(() => {})
  const nodes = (await renderDocument(parsed, options)) as Node[]

  const levels = new Map<string, number>()
  for (const style of (parsed?.stylesPart?.styles ?? []) as Style[]) {
    const level = headingLevel(style)
    if (level && style.cssName) levels.set(style.cssName, level)
  }

  into.replaceChildren()
  for (const node of nodes) {
    if (node.nodeName === 'STYLE') {
      node.textContent = readableCss(node.textContent ?? '')
      into.append(node)
    } else into.append(DOMPurify.sanitize(node as Element, { RETURN_DOM_FRAGMENT: true }))
  }

  for (const element of into.querySelectorAll<HTMLElement>('[style*="font-family"]'))
    element.style.fontFamily = withFallback(element.style.fontFamily)
  const walker = document.createTreeWalker(into, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (node.parentElement?.tagName !== 'STYLE' && symbol(text) !== text) node.nodeValue = symbol(text)
  }

  // Paragraphs end with a newline, as Markdown's blocks do, so quotes spanning them keep a space.
  // Headers and footers repeat on every page and stay out of comment quotes.
  for (const paragraph of into.querySelectorAll('p')) paragraph.after('\n')
  for (const part of into.querySelectorAll<HTMLElement>('header, footer')) part.dataset.leafSkip = ''

  const headings: Heading[] = []
  const slugs = new Map<string, number>()
  for (const paragraph of into.querySelectorAll<HTMLElement>('p[class]')) {
    const level = [...paragraph.classList].map((name) => levels.get(name)).find(Boolean)
    const text = paragraph.textContent?.trim() ?? ''
    if (!level || !text || paragraph.closest('header, footer')) continue
    const slug =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section'
    const count = slugs.get(slug) ?? 0
    slugs.set(slug, count + 1)
    paragraph.id = count ? `${slug}-${count}` : slug
    paragraph.dataset.heading = String(level)
    headings.push({ id: paragraph.id, text, level })
  }
  return headings
}
