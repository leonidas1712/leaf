/* Chrome-style tab groups: one named, coloured group per project. */
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { GROUP_COLORS, type GroupColor, type TabGroup } from '@/lib/api'
import { actions, getState, setState, useLeaf } from '@/lib/store'
import { cn } from '@/lib/utils'

/** CSS custom property carrying a group's colour; components mix it with the palette. */
export function groupStyle(color: GroupColor) {
  return { '--g': `var(--g-${color})` } as React.CSSProperties
}

export function Swatches({ value, onChange }: { value: GroupColor; onChange: (color: GroupColor) => void }) {
  return (
    <div role="radiogroup" aria-label="Group colour" className="flex flex-wrap gap-1.5">
      {GROUP_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          title={color}
          onClick={() => onChange(color)}
          style={groupStyle(color)}
          className={cn(
            'grid size-6 place-items-center rounded-full bg-(--g) text-paper transition-transform hover:scale-110',
            value === color && 'ring-2 ring-(--g) ring-offset-2 ring-offset-chrome-raised',
          )}
        >
          {value === color && <Check className="size-3.5" strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}

/** Suggest the first colour no group uses yet, like Chrome does. */
function nextColor(groups: TabGroup[]): GroupColor {
  return GROUP_COLORS.find((color) => color !== 'grey' && !groups.some((g) => g.color === color)) ?? 'blue'
}

const NO_GROUPS: TabGroup[] = []

export function GroupDialog() {
  const dialog = useLeaf((s) => s.groupDialog)
  const groups = useLeaf((s) => s.workspace?.groups ?? NO_GROUPS)
  const [name, setName] = useState('')
  const [color, setColor] = useState<GroupColor>('blue')
  const [error, setError] = useState('')
  const editing = dialog && 'group' in dialog ? dialog.group : null

  useEffect(() => {
    if (!dialog) return
    setName(editing?.name ?? '')
    setColor(editing?.color ?? nextColor(getState().workspace?.groups ?? []))
    setError('')
  }, [dialog, editing])

  const close = () => setState({ groupDialog: null })
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || !dialog) return
    if (groups.some((g) => g.name === trimmed && g.id !== editing?.id)) {
      setError('Another group already uses this name.')
      return
    }
    const failure = editing
      ? await actions.groupUpdate(editing, { name: trimmed, color })
      : await actions.groupCreate(trimmed, color, 'paths' in dialog ? dialog.paths : [])
    if (failure) setError(failure)
    else close()
  }

  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && close()}>
      <DialogContent className="top-[22%] translate-y-0 bg-chrome-raised shadow-float sm:max-w-[420px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-[15px]">{editing ? 'Edit group' : 'New group'}</DialogTitle>
            <DialogDescription className="text-[13px]">
              Groups keep a project's documents together. Close a group to put its tabs away; reopen it later
              exactly as it was.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            aria-label="Group name"
            aria-invalid={!!error}
            className="h-10 bg-paper text-[14px]"
          />
          <Swatches value={color} onChange={setColor} />
          {error && (
            <p role="alert" className="-mt-1 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {editing ? 'Save' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Shared menu for a group, used on the tab-strip chip and the sidebar row. */
export function GroupMenuItems({ group, tabCount }: { group: TabGroup; tabCount: number }) {
  return (
    <>
      <ContextMenuLabel className="flex items-center gap-2" style={groupStyle(group.color)}>
        <span className="size-2 rounded-full bg-(--g)" />
        {group.name}
      </ContextMenuLabel>
      <div className="px-2 py-1.5" onPointerDown={(event) => event.stopPropagation()}>
        <Swatches value={group.color} onChange={(color) => actions.groupUpdate(group, { color })} />
      </div>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setState({ groupDialog: { group } })}>Rename…</ContextMenuItem>
      {!group.closed && (
        <ContextMenuItem onSelect={() => actions.groupUpdate(group, { collapsed: !group.collapsed })}>
          {group.collapsed ? 'Expand' : 'Collapse'}
        </ContextMenuItem>
      )}
      {group.closed ? (
        <ContextMenuItem onSelect={() => actions.groupOpen(group)}>Reopen {group.saved?.length ?? 0} tabs</ContextMenuItem>
      ) : (
        <ContextMenuItem disabled={!tabCount} onSelect={() => actions.groupClose(group)}>
          Close group (keep for later)
        </ContextMenuItem>
      )}
      {!group.closed && (
        <ContextMenuItem
          disabled={!tabCount}
          onSelect={() => {
            const paths = getState().workspace?.tabs.filter((tab) => tab.group === group.id).map((tab) => tab.path) ?? []
            actions.ungroup(paths)
          }}
        >
          Ungroup tabs
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => actions.groupDelete(group)}>
        Delete group{tabCount ? ` and close ${tabCount} tabs` : ''}
      </ContextMenuItem>
    </>
  )
}
