/*
 * Document versions and saving. The file on disk is the truth; Leaf records the versions it
 * observes and saves with compare-and-swap against the content the editor loaded, so neither you
 * nor an agent silently overwrites the other.
 */
import { diff3Merge, diffComm } from 'node-diff3'
import { fetchFile, token } from './api'

export type VersionKind = 'save' | 'checkin' | 'external' | 'restore'

export interface Version {
  id: string
  hash: string
  at: string
  author: string | null
  kind: VersionKind
  note?: string
  added?: number
  removed?: number
  /** An agent's checkout started from this version. */
  base?: boolean
}

export interface VersionList {
  current: { hash: string; version: string | null }
  versions: Version[]
}

async function call(path: string, init?: RequestInit) {
  return fetch(path, { ...init, headers: { 'X-Leaf-Token': token, 'Content-Type': 'application/json', ...init?.headers } })
}

async function failure(response: Response) {
  try {
    return new Error((await response.json()).error ?? 'Leaf could not reach its local service.')
  } catch {
    return new Error('Leaf could not reach its local service.')
  }
}

/** "sha256:<hex>" of the exact bytes, matching the server's version hashes. */
export async function hashBytes(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return 'sha256:' + [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hashText(text: string) {
  return hashBytes(new TextEncoder().encode(text))
}

/** Read a granted file's text together with the hash of its bytes. */
export async function readText(grant: string, signal?: AbortSignal) {
  const bytes = await (await fetchFile(grant, signal)).arrayBuffer()
  return { text: new TextDecoder().decode(bytes), hash: await hashBytes(bytes) }
}

export async function listVersions(path: string): Promise<VersionList> {
  const response = await call('/api/versions?path=' + encodeURIComponent(path))
  if (!response.ok) throw await failure(response)
  return response.json()
}

export async function versionText(path: string, id: string): Promise<string> {
  const response = await call(`/api/version?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`)
  if (!response.ok) throw await failure(response)
  return response.text()
}

export type SaveResult =
  | { ok: true; version: string | null; hash: string }
  | { ok: false; conflict: { hash: string; version: string | null; text: string } }

/** Save only if the file still matches `base`; otherwise return what is on disk now. */
export async function save(path: string, base: string, text: string): Promise<SaveResult> {
  const response = await call('/api/save', { method: 'POST', body: JSON.stringify({ path, base, text }) })
  if (response.status === 409) return { ok: false, conflict: (await response.json()).current }
  if (!response.ok) throw await failure(response)
  const body: { version?: Version } = await response.json()
  return { ok: true, version: body.version?.id ?? null, hash: body.version?.hash ?? (await hashText(text)) }
}

/* ------------------------------------------------------------------ Merging */

export const MARK_MINE = '<<<<<<< your edits'
export const MARK_SPLIT = '======='
export const MARK_THEIRS = '>>>>>>> on disk'

/*
 * Any git-style marker counts, so conflicts left by `leaf merge` (mine / ||||||| base / theirs)
 * are recognised and resolvable in the editor just like Leaf's own.
 */
export const isConflictStart = (line: string) => line.startsWith('<<<<<<<')
export const isConflictBase = (line: string) => line.startsWith('|||||||')
export const isConflictSplit = (line: string) => line === '======='
export const isConflictEnd = (line: string) => line.startsWith('>>>>>>>')

const lines = (text: string) => text.split('\n')

/**
 * Three-way merge of your edits and the version on disk, both descended from `base`. Changes to
 * different lines combine; where both sides changed the same lines the result carries conflict
 * markers (the same ones `leaf merge` writes) for you to resolve.
 */
export function merge(base: string, mine: string, theirs: string) {
  const out: string[] = []
  let conflicts = 0
  for (const region of diff3Merge(lines(mine), lines(base), lines(theirs), { excludeFalseConflicts: true })) {
    if (region.ok) out.push(...region.ok)
    else if (region.conflict) {
      conflicts++
      out.push(MARK_MINE, ...region.conflict.a, MARK_SPLIT, ...region.conflict.b, MARK_THEIRS)
    }
  }
  return { text: out.join('\n'), conflicts }
}

export function countConflicts(text: string) {
  return text.split('\n').filter(isConflictStart).length
}

/* ------------------------------------------------------------------ Diffs */

export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string; old?: number; new?: number }

/** Line diff of two texts, numbered on both sides. */
export function diffLines(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = []
  let a = 1
  let b = 1
  for (const chunk of diffComm(lines(before), lines(after))) {
    if (chunk.common) for (const text of chunk.common) out.push({ kind: 'same', text, old: a++, new: b++ })
    else {
      for (const text of chunk.buffer1) out.push({ kind: 'remove', text, old: a++ })
      for (const text of chunk.buffer2) out.push({ kind: 'add', text, new: b++ })
    }
  }
  return out
}
