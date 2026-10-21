import { Minus, Monitor, Moon, Plus, Sun, Type } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ReaderPrefs, Theme } from '@/lib/api'
import { actions, DEFAULT_READER, useLeaf } from '@/lib/store'

const SEGMENT =
  'h-7 flex-1 gap-1.5 rounded-md px-2 text-[12px] text-ink-muted data-[state=on]:bg-paper data-[state=on]:text-ink data-[state=on]:shadow-xs dark:data-[state=on]:bg-rule-strong'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] font-medium text-ink-faint">{label}</span>
      {children}
    </div>
  )
}

/** Theme and typography for reading. Every control maps to a CLI action an agent can run too. */
export function ReaderSettings() {
  const theme = useLeaf((s) => s.workspace?.theme ?? 'light')
  const reader = useLeaf((s) => s.workspace?.reader) ?? DEFAULT_READER
  const set = (patch: Partial<ReaderPrefs>) => actions.readerPrefs(patch)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Reading settings" className="text-ink-muted hover:text-ink">
          <Type />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-4 bg-chrome-raised p-4 shadow-float">
        <Row label="Theme">
          <ToggleGroup
            type="single"
            value={theme}
            onValueChange={(value) => value && actions.theme(value as Theme)}
            className="w-full rounded-lg bg-accent/60 p-0.5"
          >
            <ToggleGroupItem value="light" className={SEGMENT}>
              <Sun className="size-3.5" /> Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" className={SEGMENT}>
              <Moon className="size-3.5" /> Dark
            </ToggleGroupItem>
            <ToggleGroupItem value="system" className={SEGMENT}>
              <Monitor className="size-3.5" /> Auto
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label="Typeface">
          <ToggleGroup
            type="single"
            value={reader.font}
            onValueChange={(value) => value && set({ font: value as ReaderPrefs['font'] })}
            className="w-full rounded-lg bg-accent/60 p-0.5"
          >
            <ToggleGroupItem value="sans" className={SEGMENT}>
              Sans
            </ToggleGroupItem>
            <ToggleGroupItem value="serif" className={SEGMENT + ' font-serif text-[13px]'}>
              Serif
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label="Text size">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Smaller text"
              disabled={reader.fontSize <= 12}
              onClick={() => set({ fontSize: reader.fontSize - 1 })}
            >
              <Minus />
            </Button>
            <span className="flex-1 text-center text-[13px] text-ink tabular-nums">{reader.fontSize}px</span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Larger text"
              disabled={reader.fontSize >= 28}
              onClick={() => set({ fontSize: reader.fontSize + 1 })}
            >
              <Plus />
            </Button>
          </div>
        </Row>
        <Row label="Line length">
          <ToggleGroup
            type="single"
            value={reader.width}
            onValueChange={(value) => value && set({ width: value as ReaderPrefs['width'] })}
            className="w-full rounded-lg bg-accent/60 p-0.5"
          >
            <ToggleGroupItem value="normal" className={SEGMENT}>
              Comfortable
            </ToggleGroupItem>
            <ToggleGroupItem value="wide" className={SEGMENT}>
              Wide
            </ToggleGroupItem>
            <ToggleGroupItem value="full" className={SEGMENT}>
              Full
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <p className="text-[11.5px] leading-snug text-ink-faint">
          Agents can set these too: <code className="font-mono">leaf reader</code>, <code className="font-mono">leaf theme</code>.
        </p>
      </PopoverContent>
    </Popover>
  )
}
