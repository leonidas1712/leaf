import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { saveDraft, setDraftText } from '@/lib/drafts'
import { isMarkdown } from '@/lib/markdown'
import { isTex, reportPosition, takeLine } from '@/lib/tex'
import { getState } from '@/lib/store'
import { isConflictBase, isConflictEnd, isConflictSplit, isConflictStart } from '@/lib/versions'
import type { MarkdownConfig } from '@lezer/markdown'

/*
 * YAML front matter at the top of a file. Without this, Markdown reads its closing `---` as a
 * heading underline and renders the metadata as giant headings.
 */
const frontMatter: MarkdownConfig = {
  defineNodes: [{ name: 'FrontMatter', block: true, style: tags.meta }],
  parseBlock: [
    {
      name: 'FrontMatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false
        while (cx.nextLine()) {
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            const end = cx.lineStart + line.text.length
            cx.nextLine()
            cx.addElement(cx.elt('FrontMatter', 0, end))
            return true
          }
        }
        cx.addElement(cx.elt('FrontMatter', 0, cx.prevLineEnd()))
        return true
      },
    },
  ],
}

/* ------------------------------------------------------------------ Look */

const theme = EditorView.theme({
  '&': { color: 'var(--ink-soft)', backgroundColor: 'transparent', fontSize: 'var(--body-size, 16px)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.72', overflow: 'visible' },
  '.cm-content': { padding: '0 0 40vh', caretColor: 'var(--leaf)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--leaf)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--chrome) 55%, transparent)', borderRadius: '4px' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklch, var(--g-yellow) 22%, transparent)' },
  '.cm-placeholder': { color: 'var(--ink-faint)' },
  '.cm-panels': { backgroundColor: 'var(--chrome-raised)', color: 'var(--ink)', borderColor: 'var(--rule)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--rule)', position: 'sticky', top: '0' },
  '.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '12.5px', padding: '6px 8px' },
  '.cm-search input, .cm-search button': {
    font: 'inherit', borderRadius: '6px', border: '1px solid var(--rule)', background: 'var(--paper)', color: 'var(--ink)', padding: '2px 6px',
  },
  '.cm-tooltip': { backgroundColor: 'var(--chrome-raised)', border: '1px solid var(--rule)', borderRadius: '8px' },
  '.cm-conflict-mine': { backgroundColor: 'color-mix(in oklch, var(--g-blue) 13%, transparent)' },
  '.cm-conflict-theirs': { backgroundColor: 'color-mix(in oklch, var(--g-orange) 13%, transparent)' },
})

/** Markdown keeps its punctuation but reads like the document: real heading sizes, quiet marks. */
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: '700', color: 'var(--ink)', letterSpacing: '-0.02em' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '650', color: 'var(--ink)' },
  { tag: tags.heading3, fontSize: '1.12em', fontWeight: '650', color: 'var(--ink)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '650', color: 'var(--ink)' },
  { tag: tags.strong, fontWeight: '650', color: 'var(--ink)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--leaf-ink)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--ink)' },
  { tag: tags.quote, color: 'var(--ink-muted)' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--ink-faint)' },
  { tag: tags.list, color: 'var(--ink-faint)' },
  { tag: tags.comment, color: 'var(--ink-faint)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier], color: 'var(--g-purple)' },
  { tag: [tags.string, tags.regexp], color: 'var(--g-green)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--g-orange)' },
  { tag: [tags.function(tags.variableName), tags.typeName], color: 'var(--g-blue)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--g-red)' },
])

/* ------------------------------------------------------------------ Conflicts */

interface Block {
  start: number // line numbers (1-based) of the markers
  base?: number // optional diff3 "||||||| base" section, shown dimmed
  split: number
  end: number
  ours: string // labels after the markers, e.g. "your edits" / "on disk", or "mine" / "theirs"
  theirs: string
}

function conflictBlocks(state: EditorState): Block[] {
  const blocks: Block[] = []
  let open: { start?: number; base?: number; split?: number; ours?: string } = {}
  for (let n = 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text
    if (isConflictStart(text)) open = { start: n, ours: text.slice(7).trim() || 'first version' }
    else if (isConflictBase(text) && open.start && !open.split) open.base = n
    else if (isConflictSplit(text) && open.start) open.split = n
    else if (isConflictEnd(text) && open.start && open.split) {
      blocks.push({ start: open.start, base: open.base, split: open.split, end: n, ours: open.ours!, theirs: text.slice(7).trim() || 'second version' })
      open = {}
    }
  }
  return blocks
}

function resolveBlock(view: EditorView, startLine: number, keep: 'mine' | 'theirs' | 'both') {
  const block = conflictBlocks(view.state).find((b) => b.start === startLine)
  if (!block) return
  const doc = view.state.doc
  const take = (from: number, to: number) => (from > to ? [] : Array.from({ length: to - from + 1 }, (_, i) => doc.line(from + i).text))
  const mine = take(block.start + 1, (block.base ?? block.split) - 1)
  const theirs = take(block.split + 1, block.end - 1)
  const kept = keep === 'mine' ? mine : keep === 'theirs' ? theirs : [...mine, ...theirs]
  const from = doc.line(block.start).from
  const end = doc.line(block.end)
  // Remove the block's trailing newline too when nothing is kept.
  const to = kept.length || end.number === doc.lines ? end.to : end.to + 1
  view.dispatch({ changes: { from, to, insert: kept.join('\n') } })
  view.focus()
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

class MarkerWidget extends WidgetType {
  readonly kind: 'start' | 'base' | 'split' | 'end'
  readonly block: Block
  constructor(kind: 'start' | 'base' | 'split' | 'end', block: Block) {
    super()
    this.kind = kind
    this.block = block
  }
  eq(other: MarkerWidget) {
    return other.kind === this.kind && other.block.start === this.block.start && other.block.ours === this.block.ours
  }
  toDOM(view: EditorView) {
    const bar = document.createElement('span')
    bar.className = 'cm-conflict-bar'
    bar.dataset.kind = this.kind
    const label = document.createElement('span')
    label.textContent =
      this.kind === 'start'
        ? capital(this.block.ours)
        : this.kind === 'base'
          ? 'Before either change'
          : this.kind === 'split'
            ? capital(this.block.theirs)
            : ''
    bar.append(label)
    if (this.kind === 'start') {
      for (const [text, keep] of [
        [`Keep ${this.block.ours}`, 'mine'],
        [`Keep ${this.block.theirs}`, 'theirs'],
        ['Keep both', 'both'],
      ] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = text
        button.onmousedown = (event) => event.preventDefault()
        button.onclick = () => resolveBlock(view, this.block.start, keep)
        bar.append(button)
      }
    }
    return bar
  }
  ignoreEvent() {
    return false
  }
}

function conflictDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  for (const block of conflictBlocks(view.state)) {
    for (let n = block.start; n <= block.end; n++) {
      const line = doc.line(n)
      const marker =
        n === block.start ? 'start' : n === block.base ? 'base' : n === block.split ? 'split' : n === block.end ? 'end' : null
      const region =
        block.base && n > block.base && n < block.split
          ? 'cm-conflict-base'
          : n < (block.base ?? block.split)
            ? 'cm-conflict-mine'
            : 'cm-conflict-theirs'
      builder.add(line.from, line.from, Decoration.line({ class: region }))
      if (marker) builder.add(line.from, line.to, Decoration.replace({ widget: new MarkerWidget(marker, block) }))
    }
  }
  return builder.finish()
}

const conflicts = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = conflictDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = conflictDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/* ------------------------------------------------------------------ Component */

/**
 * The document editor. CodeMirror owns the text while you type; the draft store gets it shortly
 * after, and text arriving from a merge or a disk reload replaces the editor's content.
 */
export function Editor({ path, text, fontSize }: { path: string; text: string; fontSize: number }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** The last text this editor pushed to the store; echoes of it are not external changes. */
  const pushed = useRef<string | null>(null)

  useEffect(() => {
    if (!host.current) return
    // Push every change straight to the draft: close and reload guards must see edits made a
    // millisecond ago. Only the split preview is debounced.
    const flush = (v: EditorView) => {
      pushed.current = v.state.doc.toString()
      setDraftText(path, pushed.current)
    }
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      closeBrackets(),
      autocompletion({ override: [] }),
      search({ top: true }),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      placeholder('Start writing…'),
      theme,
      syntaxHighlighting(highlight),
      conflicts,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: (v) => (flush(v), saveDraft(path), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        // Last, so Esc first closes find and collapses extra cursors. Leaving the editor lets
        // single-key shortcuts work again: Esc, then r, returns to reading.
        { key: 'Escape', run: (v) => (v.contentDOM.blur(), true) },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) flush(update.view)
        // A live PDF follows the cursor in a LaTeX source.
        if (isTex(path) && update.view.hasFocus && (update.selectionSet || update.focusChanged))
          reportPosition(path, update.state.doc.lineAt(update.state.selection.main.head).number)
      }),
    ]
    // Other sources (LaTeX, YAML, JSON) load their language lazily once the editor is open.
    const language = new Compartment()
    const other = isMarkdown(path) ? null : LanguageDescription.matchFilename(languages, path)
    extensions.push(language.of(isMarkdown(path) ? markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [frontMatter] }) : []))
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: getState().drafts[path]?.text ?? '', extensions }),
    })
    other?.load().then((support) => {
      if (view.current === editor) editor.dispatch({ effects: language.reconfigure(support) })
    })
    view.current = editor
    editor.focus()
    // A jump from the PDF or an error list puts the cursor on that line.
    const goto = () => {
      const line = takeLine(path)
      if (!line) return
      const at = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines)).from
      editor.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
      editor.focus()
    }
    const onGoto = (event: Event) => (event as CustomEvent<string>).detail === path && goto()
    window.addEventListener('leaf:goto-line', onGoto)
    goto()
    return () => {
      window.removeEventListener('leaf:goto-line', onGoto)
      flush(editor)
      editor.destroy()
      view.current = null
    }
  }, [path])

  // Text replaced from outside (merge, discard, disk reload): adopt it unless it's ours already.
  useEffect(() => {
    const editor = view.current
    if (!editor || text === pushed.current || editor.state.doc.toString() === text) return
    pushed.current = text
    const head = Math.min(editor.state.selection.main.head, text.length)
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: { anchor: head } })
  }, [text])

  return <div ref={host} className="leaf-editor" style={{ '--body-size': `${fontSize}px` } as React.CSSProperties} />
}
