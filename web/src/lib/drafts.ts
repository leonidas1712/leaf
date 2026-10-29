/*
 * Editing lifecycle for one document: load → edit → save with compare-and-swap. When the file
 * changed underneath (an agent edited it), edits are three-way merged with the disk version;
 * overlapping changes become conflict markers to resolve before saving.
 */
import { toast } from 'sonner'
import { act, getState, isPdf, isReadOnly, setState, type Draft } from './store'
import { countConflicts, hashText, merge, readText, save } from './versions'
import { basename } from './paths'

function update(path: string, patch: Partial<Draft> | null) {
  const drafts = { ...getState().drafts }
  if (patch === null) delete drafts[path]
  else drafts[path] = { ...drafts[path], ...patch } as Draft
  setState({ drafts })
}

export function isDirty(draft: Draft | undefined) {
  return !!draft && draft.text !== draft.base
}

/** Advisory presence so agents running `leaf checkout` see that you have unsaved edits. */
function presence(path: string, editing: boolean) {
  act({ action: editing ? 'edit-start' : 'edit-end', path, author: 'you' }, undefined, true)
}

export async function openEditor(path: string, mode: 'edit' | 'split') {
  const { workspace, entries, drafts } = getState()
  if (isReadOnly(path)) {
    toast(isPdf(path) ? 'PDFs are read-only in Leaf.' : 'Word documents are read-only in Leaf. Edit them in Word.')
    return
  }
  if (workspace?.sources?.[path]) {
    toast('Board documents are read-only in Leaf. Edit them on the board.')
    return
  }
  const grant = entries.get(path)?.id
  if (!grant) {
    toast.error('This document is not available to edit.')
    return
  }
  if (!drafts[path]) {
    try {
      const { text, hash } = await readText(grant)
      update(path, { base: text, baseHash: hash, text })
    } catch (error) {
      toast.error((error as Error).message)
      return
    }
  }
  setState({ editModes: { ...getState().editModes, [path]: mode } })
}

export function closeEditor(path: string) {
  const editModes = { ...getState().editModes }
  delete editModes[path]
  // A clean draft has nothing worth keeping; dirty ones survive so the tab keeps its edits.
  if (!isDirty(getState().drafts[path])) update(path, null)
  setState({ editModes })
}

export function setDraftText(path: string, text: string) {
  const draft = getState().drafts[path]
  if (!draft || draft.text === text) return
  const wasDirty = isDirty(draft)
  update(path, { text })
  const dirty = text !== draft.base
  if (dirty !== wasDirty) presence(path, dirty)
}

export function discardDraft(path: string) {
  const draft = getState().drafts[path]
  if (!draft) return
  update(path, { text: draft.base, incoming: undefined })
  presence(path, false)
}

/** Fold a disk version into the draft: clean merges apply, overlaps become markers. */
function absorb(path: string, theirs: string, theirsHash: string) {
  const draft = getState().drafts[path]
  if (!draft) return 0
  const { text, conflicts } = merge(draft.base, draft.text, theirs)
  update(path, { base: theirs, baseHash: theirsHash, text, incoming: undefined })
  return conflicts
}

export async function saveDraft(path: string): Promise<boolean> {
  const draft = getState().drafts[path]
  if (!draft || draft.saving) return false
  const markers = countConflicts(draft.text)
  if (markers) {
    toast.error(`Resolve ${markers} conflict${markers > 1 ? 's' : ''} before saving.`)
    return false
  }
  update(path, { saving: true })
  try {
    const result = await save(path, draft.baseHash, draft.text)
    if (result.ok) {
      update(path, { base: draft.text, baseHash: result.hash, saving: false, incoming: undefined })
      presence(path, false)
      return true
    }
    // Someone changed the file since we loaded it: merge, then save again if that was clean.
    update(path, { saving: false })
    const conflicts = absorb(path, result.conflict.text, result.conflict.hash)
    if (conflicts) {
      toast.warning(`${basename(path)} changed on disk. ${conflicts} overlapping change${conflicts > 1 ? 's need' : ' needs'} your decision.`)
      return false
    }
    toast(`Merged changes from disk into your edits.`)
    return saveDraft(path)
  } catch (error) {
    update(path, { saving: false })
    toast.error((error as Error).message)
    return false
  }
}

/**
 * The file changed on disk while open in the editor. Clean drafts follow it silently; drafts with
 * unsaved edits hold the new version until you choose to merge it.
 */
export async function diskChanged(path: string, grant: string) {
  const draft = getState().drafts[path]
  if (!draft || draft.saving) return
  const { text, hash } = await readText(grant)
  if (hash === draft.baseHash || hash === (await hashText(draft.text))) return
  if (!isDirty(draft)) update(path, { base: text, baseHash: hash, text })
  else update(path, { incoming: { text, hash } })
}

export function mergeIncoming(path: string) {
  const incoming = getState().drafts[path]?.incoming
  if (!incoming) return
  const conflicts = absorb(path, incoming.text, incoming.hash)
  if (conflicts) toast.warning(`${conflicts} overlapping change${conflicts > 1 ? 's' : ''} marked in the editor.`)
  else toast.success('Merged the new version into your edits.')
}
