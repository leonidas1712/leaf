import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { actions, setState, useLeaf } from '@/lib/store'

/** Paste a local path. Browsers can't hand Leaf a real path, so this is the one typed input. */
export function OpenDialog() {
  const mode = useLeaf((s) => s.openDialog)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const folder = mode === 'open-folder'

  const close = () => {
    setState({ openDialog: null })
    setValue('')
    setError('')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const path = value.trim()
    if (!path) return
    setBusy(true)
    setError('')
    const failure = folder ? await actions.openFolder(path, true) : await actions.open(path, true)
    setBusy(false)
    if (failure) setError(failure)
    else close()
  }

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="top-[22%] translate-y-0 bg-chrome-raised shadow-float sm:max-w-[520px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-[15px]">{folder ? 'Add a folder' : 'Open a document'}</DialogTitle>
            <DialogDescription className="text-[13px]">
              {folder
                ? 'Its Markdown and text files join the sidebar. Your open tabs stay put.'
                : 'Markdown, text, JSON, YAML, CSV, or log files.'}{' '}
              Agents can do the same with <code className="font-mono text-[12px] text-ink">leaf open PATH</code>.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={folder ? '~/projects/atlas/docs' : '~/projects/atlas/PLAN.md'}
            aria-label={folder ? 'Folder path' : 'Document path'}
            aria-invalid={!!error}
            className="h-10 bg-paper font-mono text-[13px]"
          />
          {error && (
            <p role="alert" className="-mt-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {folder ? 'Add folder' : 'Open'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
