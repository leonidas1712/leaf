import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PathInput } from './PathInput'
import { trail } from '@/lib/collections'
import { basename } from '@/lib/paths'
import { act, actions, setState, useLeaf } from '@/lib/store'

/**
 * Paste a local path. Browsers can't hand Leaf a real path, so this is the one typed input.
 * Adding to a collection keeps the dialog open so several documents can be linked in a row.
 */
export function OpenDialog() {
  const mode = useLeaf((s) => s.openDialog)
  const collections = useLeaf((s) => s.workspace?.collections)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [added, setAdded] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const folder = mode === 'open-folder'
  const target = typeof mode === 'object' && mode ? collections?.find((c) => c.id === mode.collection) : undefined
  const where = target ? trail(collections ?? [], target.id).join(' › ') : ''

  const close = () => {
    setState({ openDialog: null })
    setValue('')
    setError('')
    setAdded([])
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const path = value.trim()
    if (!path) return
    setBusy(true)
    setError('')
    const failure = target
      ? await act({ action: 'collection-add', collection: target.id, paths: [path] }, undefined, true)
      : folder
        ? await actions.openFolder(path, true)
        : await actions.open(path, { quiet: true })
    setBusy(false)
    if (failure) setError(failure)
    else if (target) {
      setAdded((list) => [...list, basename(path)])
      setValue('')
    } else close()
  }

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="top-[22%] translate-y-0 bg-chrome-raised shadow-float sm:max-w-[560px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {target ? `Add to ${where}` : folder ? 'Add a folder' : 'Open a document'}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {target
                ? 'Link a document from anywhere on disk. It stays where it is.'
                : folder
                  ? 'Its Markdown and text files join the sidebar. Your open tabs stay put.'
                  : 'Markdown, LaTeX, PDF, text, JSON, YAML, CSV, or log files.'}{' '}
              Agents can do this with{' '}
              <code className="font-mono text-[12px] text-ink">
                {target ? `leaf collection add "${where.replaceAll(' › ', '/')}" PATH` : 'leaf open PATH'}
              </code>
              .
            </DialogDescription>
          </DialogHeader>
          <PathInput
            value={value}
            onChange={setValue}
            foldersOnly={folder}
            invalid={!!error}
            label={folder ? 'Folder path' : 'Document path'}
            placeholder={folder ? '~/projects/atlas/docs' : '~/projects/atlas/PLAN.md'}
          />
          {error && (
            <p role="alert" className="-mt-2 text-[13px] text-destructive">
              {error}
            </p>
          )}
          {added.length > 0 && (
            <p className="-mt-2 text-[12.5px] text-ink-muted">
              Added {added.join(', ')}. Paste another path, or close when done.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {added.length ? 'Done' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {target ? 'Add' : folder ? 'Add folder' : 'Open'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
