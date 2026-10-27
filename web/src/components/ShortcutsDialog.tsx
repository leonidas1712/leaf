import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { setState, useLeaf } from '@/lib/store'

/** Keep in step with the bindings in App.tsx, the editor keymap, and the comment card. */
const SECTIONS: { title: string; note?: string; rows: [keys: string[][], label: string, between?: string][] }[] = [
  {
    title: 'Tabs',
    note: 'Single keys work while you are not typing.',
    rows: [
      [[['['], [']']], 'Previous / next tab, within its group'],
      [[['1'], ['8']], 'Go to tab 1–8', '–'],
      [[['9']], 'Go to the last tab'],
      [[['X']], 'Close tab'],
      [[['O']], 'Open a document'],
      [[['P']], 'Pin or unpin'],
      [[['|']], 'Split with the previous document, or close the split'],
    ],
  },
  {
    title: 'Reading',
    rows: [
      [[['⌘', 'F']], 'Find in document'],
      [
        [
          ['⌘', 'G'],
          ['⇧', '⌘', 'G'],
        ],
        'Next / previous match',
      ],
      [[['S']], 'Formatted or Markdown source'],
      [[['T']], 'Light or dark theme'],
      [[['/']], 'Filter the sidebar'],
      [[['⌘', '\\']], 'Show or hide the sidebar'],
      [[['⌘', '.']], 'Show or hide the outline and comments'],
    ],
  },
  {
    title: 'Comments',
    rows: [
      [[['C']], 'Comment on the selection, or the whole document'],
      [[['⌘', '⌥', 'M']], 'Comment on the selection'],
      [[['⌘', '↵']], 'Post the comment'],
      [[['Esc']], 'Cancel the comment'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      [[['E']], 'Edit at the selection or reading position, or back to reading'],
      [[['⌘', 'S']], 'Save'],
      [[['Esc'], ['R']], 'Leave the editor, then read', 'then'],
    ],
  },
  {
    title: 'LaTeX',
    note: 'In a project compiled with Live PDF preview.',
    rows: [
      [[['B']], 'Recompile now'],
      [[['Double-click']], 'In the PDF: show the source line'],
      [[['⌥', 'Double-click']], 'In the PDF: edit the source line'],
    ],
  },
  {
    title: 'Everywhere',
    rows: [
      [[['⌘', 'K']], 'Command palette'],
      [[['?']], 'These shortcuts'],
    ],
  },
]

export function ShortcutsDialog() {
  const open = useLeaf((s) => s.shortcutsOpen)
  return (
    <Dialog open={open} onOpenChange={(value) => setState({ shortcutsOpen: value })}>
      <DialogContent className="max-h-[85vh] overflow-y-auto bg-chrome-raised shadow-float sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="text-[13px]">⌘ is Ctrl outside macOS.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-faint uppercase">{section.title}</h3>
              <ul className="grid gap-1">
                {section.rows.map(([keys, label, between = '/']) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-[13px] text-ink-muted">
                    <span>{label}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
                      {keys.map((combo, index) => (
                        <span key={index} className="flex items-center gap-1">
                          {index > 0 && <span>{between}</span>}
                          <KbdGroup>
                            {combo.map((key) => (
                              <Kbd key={key}>{key}</Kbd>
                            ))}
                          </KbdGroup>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
              {section.note && <p className="mt-1.5 text-[11.5px] text-ink-faint">{section.note}</p>}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
