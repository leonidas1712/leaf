/* Local bridge transport. The server injects the token into index.html; every API call carries it. */

export type Theme = 'light' | 'dark' | 'system'

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

export interface SavedTab {
  path: string
  scroll: number
  group?: string | null
}

export interface TabGroup {
  id: string
  name: string
  color: GroupColor
  collapsed: boolean
  closed: boolean
  /** Tabs held while the group is closed, restored by group-open. */
  saved?: SavedTab[]
}

/** A Leaf-only folder of document references; documents stay where they are on disk. */
export interface Collection {
  id: string
  name: string
  parent: string | null
  color: GroupColor | null
  docs: string[]
}

/**
 * Where a comment points: the passage the reader selected, with context to find it again after
 * edits. Quote anchors survive rewrites that offsets would not; null anchors cover the whole doc.
 */
export interface CommentAnchor {
  quote: string
  prefix: string
  suffix: string
  heading?: string
}

export type CommentStatus = 'open' | 'working' | 'resolved'

export interface CommentReply {
  id: string
  author: string
  body: string
  created: string
  edited?: string
  /** Set when this timeline entry records a status change; body is the optional note. */
  status?: CommentStatus
}

export interface Comment {
  id: string
  path: string
  anchor: CommentAnchor | null
  body: string
  author: string
  created: string
  updated?: string
  /** Set when the first message's text was edited. */
  edited?: string
  status: CommentStatus
  statusBy?: string
  statusAt?: string
  replies: CommentReply[]
}

export interface ReaderPrefs {
  fontSize: number
  width: 'normal' | 'wide' | 'full'
  font: 'sans' | 'serif'
}

export interface DocumentSource {
  kind: 'aboard'
  server?: string
  board: string
  file: string
  version?: number
  fetchedAt?: string
}

export interface Workspace {
  version: number
  revision: number
  folders: string[]
  files: string[]
  tabs: SavedTab[]
  active: string | null
  recentFiles: string[]
  recentFolders: string[]
  theme: Theme
  source: boolean
  search: string
  sidebarWidth: number
  /** Advisory: who said they are editing which document (agents via `leaf checkout`). */
  editing?: Record<string, { author: string; since: string; base?: string }>
  expanded: string[]
  groups?: TabGroup[]
  collections?: Collection[]
  comments?: Comment[]
  sources?: Record<string, DocumentSource>
  reader?: ReaderPrefs
}

export interface Entry {
  path: string
  id?: string
  error?: string
}

export interface Hydration {
  workspace: Workspace
  entries: Entry[]
  missing: { path: string; error: string }[]
}

export interface SyncResponse extends Partial<Hydration> {
  instance: string
  revision: number
  commands: LiveCommand[]
  /** Opaque change markers per open path (mtime_ns:size); compare for equality only. */
  stamps?: Record<string, string | null>
}

export interface LiveCommand {
  id: string
  action: string
  path?: string
}

export interface ActionResponse {
  status: 'saved'
  revision: number
  workspace: Workspace
}

export const token =
  document.querySelector<HTMLMetaElement>('meta[name="leaf-agent-token"]')?.content ?? ''

export const connected = token !== '' && token !== '__LEAF_TOKEN__'

async function request(path: string, body?: unknown, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Leaf-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  })
  if (!response.ok) {
    let message = 'Leaf could not reach its local service.'
    try {
      message = (await response.json()).error ?? message
    } catch {
      /* Non-JSON failure: keep the generic message. */
    }
    throw new Error(message)
  }
  return response
}

export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  return (await request(path, body)).json()
}

export function sendAction(action: Record<string, unknown>): Promise<ActionResponse> {
  return postJSON<ActionResponse>('/api/action', action)
}

export async function fetchFile(id: string, signal?: AbortSignal): Promise<Blob> {
  return (await request('/api/file?id=' + encodeURIComponent(id), undefined, { signal })).blob()
}

export interface Completion {
  path: string
  kind: 'dir' | 'file'
}

/** Children of the deepest existing directory in a typed path, filtered by the typed prefix. */
export async function completePath(prefix: string, signal?: AbortSignal): Promise<Completion[]> {
  return (await request('/api/complete?path=' + encodeURIComponent(prefix), undefined, { signal })).json()
}

/** Show a file or folder in the system file manager (Finder on macOS). */
export function reveal(path: string) {
  return postJSON<{ status: string }>('/api/reveal', { path })
}

export const REVEAL_LABEL = /Mac/i.test(navigator.platform) ? 'Reveal in Finder' : 'Show in folder'

/** Fire-and-forget final save while the page unloads. */
export function beacon(path: string, body: unknown) {
  fetch(path, {
    method: 'POST',
    keepalive: true,
    headers: { 'X-Leaf-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}
