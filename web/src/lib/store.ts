/*
 * One store for the canonical workspace plus the reader's fast-moving view state.
 *
 * Durable structure (tabs, active, theme, view, folders) changes through /api/action — the
 * same path the CLI uses — so anything the UI can do an agent can do. High-frequency view
 * state (scroll per tab, expanded folders, filter text, sidebar width) rides /api/sync with
 * compare-and-swap on the workspace revision. A stale write is rejected and the server
 * returns canonical state, which replaces local state wholesale.
 */
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import {
  beacon,
  connected,
  postJSON,
  sendAction,
  type Entry,
  type Collection,
  type GroupColor,
  type Hydration,
  type ReaderPrefs,
  type TabGroup,
  type LiveCommand,
  type SavedTab,
  type SyncResponse,
  type Theme,
  type Workspace,
} from './api'

export const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|csv|log)$/i

export interface Heading {
  id: string
  text: string
  level: number
}

export type Connection = 'connecting' | 'live' | 'offline' | 'unauthenticated'

export interface LeafState {
  connection: Connection
  workspace: Workspace | null
  entries: Map<string, Entry>
  missing: Hydration['missing']
  expanded: Set<string>
  search: string
  sidebarWidth: number
  outlineOpen: boolean
  sidebarOpen: boolean
  paletteOpen: boolean
  /** Path prompt: open a document, add a folder, or add a document to a collection. */
  openDialog: null | 'open-file' | 'open-folder' | { collection: string }
  /** Create a group from these tab paths, or edit an existing group. */
  groupDialog: null | { paths: string[] } | { group: TabGroup }
  /** Create a collection (optionally nested, optionally seeded with documents), or edit one. */
  collectionDialog: null | { parent: string | null; paths?: string[] } | { collection: Collection }
  headings: Heading[]
  status: string
  /** Change markers for open documents; a new value means the file changed on disk. */
  stamps: Record<string, string | null>
}

const readerSession = crypto.randomUUID()

let state: LeafState = {
  connection: connected ? 'connecting' : 'unauthenticated',
  workspace: null,
  entries: new Map(),
  missing: [],
  expanded: new Set(),
  search: '',
  sidebarWidth: 280,
  sidebarOpen: true,
  outlineOpen: true,
  paletteOpen: false,
  openDialog: null,
  groupDialog: null,
  collectionDialog: null,
  headings: [],
  status: '',
  stamps: {},
}

const listeners = new Set<() => void>()

/** Per-tab scroll positions. Mutated on every scroll event, so deliberately not reactive. */
export const scrolls = new Map<string, number>()

export function getState() {
  return state
}

export function setState(patch: Partial<LeafState>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function useLeaf<T>(selector: (s: LeafState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => selector(state),
  )
}

/* ------------------------------------------------------------------ Reader hooks */

/**
 * The document view registers how to answer live commands and when rendering is in flight.
 * Sync waits while a render runs so a reported revision means the reader actually shows it.
 */
export const reader = {
  rendering: false,
  scrollTop: () => 0,
  scrollToHeading: (_target: string): boolean => false,
  rememberActiveScroll: () => {},
  applyScroll: (_path: string, _top: number) => {},
}

/* ------------------------------------------------------------------ Sync protocol */

let revision = -1
let instance: string | null = null
let lastSavedView = ''
let busy = false
let forceHydrate = false

function view(ws: Workspace) {
  reader.rememberActiveScroll()
  return {
    folders: ws.folders,
    files: ws.files,
    tabs: ws.tabs.map((tab) => ({ ...tab, scroll: Math.round(scrolls.get(tab.path) ?? tab.scroll ?? 0) })),
    active: ws.active,
    theme: ws.theme,
    source: ws.source,
    search: state.search,
    sidebarWidth: state.sidebarWidth,
    // The server rejects expansion keys for collections that no longer exist.
    expanded: [...state.expanded].filter(
      (key) => !key.startsWith('collection:') || ws.collections?.some((c) => 'collection:' + c.id === key),
    ),
  }
}

export function snapshot() {
  const ws = state.workspace
  const documents = [...state.entries.keys()].filter((path) => TEXT_FILE.test(path))
  return {
    revision,
    session: readerSession,
    title: document.title,
    rootPath: null,
    active: ws?.active ?? null,
    tabs: ws?.tabs.map((tab) => tab.path) ?? [],
    source: ws?.source ?? false,
    theme: ws?.theme ?? 'light',
    search: state.search,
    folders: ws?.folders.map((path) => ({ path, expanded: state.expanded.has(path) })) ?? [],
    documents: documents.slice(0, 500),
    documentCount: documents.length,
    headings: state.headings.map(({ id, text }) => ({ id, text })),
    scroll: reader.scrollTop(),
    sidebarWidth: state.sidebarWidth,
    status: state.status,
  }
}

function hydrate(payload: Hydration) {
  const ws = payload.workspace
  // Positions we last synced, to tell an agent's `leaf scroll` apart from our own stale echo.
  const synced = new Map<string, number>(
    lastSavedView ? (JSON.parse(lastSavedView).tabs as SavedTab[]).map((tab) => [tab.path, tab.scroll]) : [],
  )
  reader.rememberActiveScroll()
  const live = new Map(scrolls)
  scrolls.clear()
  for (const tab of ws.tabs) {
    const changedRemotely = synced.has(tab.path) && Math.round(synced.get(tab.path)!) !== Math.round(tab.scroll)
    const local = live.get(tab.path)
    scrolls.set(tab.path, changedRemotely || local === undefined ? tab.scroll : local)
    if (changedRemotely && tab.path === ws.active) reader.applyScroll(tab.path, tab.scroll)
  }
  setState({
    workspace: ws,
    entries: new Map(payload.entries.map((entry) => [entry.path, entry])),
    missing: payload.missing,
    expanded: new Set(ws.expanded),
    search: ws.search,
    sidebarWidth: ws.sidebarWidth,
  })
}

async function runLiveCommand(command: LiveCommand) {
  if (command.action === 'heading') {
    if (!command.path || !reader.scrollToHeading(command.path))
      throw new Error('Heading not found. Use state to inspect headings.')
  } else if (command.action !== 'state') {
    throw new Error('Unknown live command: ' + command.action)
  }
}

let chain: Promise<unknown> = Promise.resolve()

/** Run one exchange with the server. Actions and syncs never overlap; they queue in order. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    busy = true
    try {
      return await work()
    } finally {
      busy = false
    }
  })
  chain = run.catch(() => {})
  return run
}

async function syncOnce() {
  const ws = state.workspace
  const request: Record<string, unknown> = { instance, session: readerSession, revision, viewOnly: true, state: snapshot() }
  let encoded = ''
  if (forceHydrate) {
    request.revision = -1
    forceHydrate = false
  } else if (ws && revision >= 0) {
    const current = view(ws)
    encoded = JSON.stringify(current)
    if (encoded !== lastSavedView) request.view = current
  }
  const response = await postJSON<SyncResponse>('/api/sync', request)
  instance = response.instance
  if (response.stamps && JSON.stringify(response.stamps) !== JSON.stringify(state.stamps)) setState({ stamps: response.stamps })
  if (response.workspace) {
    hydrate(response as Hydration)
    revision = response.revision
    lastSavedView = JSON.stringify(view(response.workspace))
  } else {
    revision = response.revision
    if (state.workspace && state.workspace.revision !== revision)
      setState({ workspace: { ...state.workspace, revision } })
    lastSavedView = encoded || lastSavedView
  }
  for (const command of response.commands) {
    let error: string | undefined
    try {
      await runLiveCommand(command)
    } catch (failure) {
      error = (failure as Error).message
    }
    await postJSON('/api/ack', { session: readerSession, id: command.id, state: snapshot(), error })
  }
  if (state.connection !== 'live') setState({ connection: 'live' })
}

export async function poll() {
  if (!connected || busy || reader.rendering) return
  try {
    await exclusive(syncOnce)
  } catch {
    setState({ connection: 'offline' })
  }
}

export function startSync() {
  if (!connected) return
  poll()
  const timer = setInterval(poll, 750)
  const visible = () => !document.hidden && poll()
  document.addEventListener('visibilitychange', visible)
  const unload = () => {
    const ws = state.workspace
    if (!ws || revision < 0 || busy) return
    beacon('/api/sync', { instance, session: readerSession, revision, viewOnly: true, view: view(ws), state: snapshot() })
  }
  window.addEventListener('pagehide', unload)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('pagehide', unload)
  }
}

/* ------------------------------------------------------------------ Durable actions */

type Optimistic = (ws: Workspace) => Workspace

/**
 * Apply a durable workspace action. The optimistic update renders immediately; the server
 * response then becomes canonical. Actions that grant new files rehydrate to receive them.
 * Resolves to an error message (already toasted unless `quiet`) or null on success.
 */
export async function act(action: Record<string, unknown>, optimistic?: Optimistic, quiet = false): Promise<string | null> {
  const before = state.workspace
  if (optimistic && before) setState({ workspace: optimistic(before) })
  try {
    await exclusive(async () => {
      // Flush pending view changes first so the action builds on them instead of discarding them.
      if (state.workspace && revision >= 0) {
        const current = view(state.workspace)
        const encoded = JSON.stringify(current)
        if (encoded !== lastSavedView) {
          const synced = await postJSON<SyncResponse>('/api/sync', {
            instance, session: readerSession, revision, viewOnly: true, view: current, state: snapshot(),
          })
          instance = synced.instance
          revision = synced.revision
          if (synced.workspace) hydrate(synced as Hydration)
          else lastSavedView = encoded
        }
      }
      const response = await sendAction(action)
      // These add tabs or folders whose file grants only arrive with a full hydration.
      const grants = ['open-file', 'open-folder', 'refresh', 'group-open', 'collection-open', 'collection-add', 'collection-create']
      if (grants.includes(String(action.action))) forceHydrate = true
      else {
        revision = response.revision
        setState({ workspace: response.workspace })
        lastSavedView = JSON.stringify(view(response.workspace))
      }
    })
    if (forceHydrate) await poll()
    return null
  } catch (error) {
    const message = (error as Error).message
    if (before && optimistic) setState({ workspace: before })
    setState({ status: message })
    if (!quiet) toast.error(message)
    return message
  }
}

/* Small vocabulary of UI intents; each maps to exactly one CLI-visible action. */

export const actions = {
  focus: (path: string) => {
    reader.rememberActiveScroll()
    return act({ action: 'focus-tab', path }, (ws) => ({ ...ws, active: path }))
  },
  open: (path: string, { quiet = false, group }: { quiet?: boolean; group?: string } = {}) => {
    reader.rememberActiveScroll()
    const ws = state.workspace
    if (ws?.tabs.some((tab) => tab.path === path)) return actions.focus(path)
    // Typed paths ("~/x.md", relative) resolve on the server; only absolute ones render optimistically.
    const optimistic: Optimistic | undefined = path.startsWith('/')
      ? (w) => ({ ...w, tabs: [...w.tabs, { path, scroll: 0, group: group ?? null }], active: path })
      : undefined
    return act({ action: 'open-file', path, ...(group ? { group } : {}) }, optimistic, quiet)
  },
  /** Put a document into a group: an open tab joins it; a closed document opens inside it. */
  addToGroup: (path: string, group: TabGroup) =>
    state.workspace?.tabs.some((tab) => tab.path === path)
      ? act({ action: 'group-add', group: group.id, paths: [path] })
      : actions.open(path, { group: group.id }),
  openFolder: (path: string, quiet = false) => act({ action: 'open-folder', path }, undefined, quiet),
  close: (path: string) =>
    act({ action: 'close-tab', path }, (ws) => {
      const index = ws.tabs.findIndex((tab) => tab.path === path)
      const tabs = ws.tabs.filter((tab) => tab.path !== path)
      const active = ws.active === path ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null) : ws.active
      return { ...ws, tabs, active }
    }),
  reorder: (paths: string[]) =>
    act({ action: 'reorder-tabs', paths }, (ws) => ({
      ...ws,
      tabs: paths.map((path) => ws.tabs.find((tab) => tab.path === path)!),
    })),
  theme: (theme: Theme) => act({ action: 'theme', path: theme }, (ws) => ({ ...ws, theme })),
  view: (source: boolean) =>
    act({ action: 'view', path: source ? 'source' : 'formatted' }, (ws) => ({ ...ws, source })),
  removeFolder: (path: string) =>
    act({ action: 'remove-folder', path }, (ws) => ({ ...ws, folders: ws.folders.filter((f) => f !== path) })),
  refresh: () => act({ action: 'refresh' }),

  groupCreate: (name: string, color: GroupColor, paths: string[]) => act({ action: 'group-create', name, color, paths }),
  groupUpdate: (group: TabGroup, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>) =>
    act({ action: 'group-update', group: group.id, ...patch }, (ws) => ({
      ...ws,
      groups: ws.groups?.map((g) => (g.id === group.id ? { ...g, ...patch } : g)),
    })),
  ungroup: (paths: string[]) => act({ action: 'group-ungroup', paths }),
  groupClose: (group: TabGroup) => {
    reader.rememberActiveScroll()
    return act({ action: 'group-close', group: group.id })
  },
  groupOpen: (group: TabGroup) => act({ action: 'group-open', group: group.id }),
  groupDelete: (group: TabGroup) => act({ action: 'group-delete', group: group.id }),
  moveTab: (path: string, index: number, group?: string | null) =>
    act({ action: 'move-tab', path, index, ...(group === undefined ? {} : { group }) }, (ws) => {
      const tab = ws.tabs.find((t) => t.path === path)!
      const tabs = ws.tabs.filter((t) => t.path !== path)
      tabs.splice(index, 0, group === undefined ? tab : { ...tab, group })
      return { ...ws, tabs }
    }),
  readerPrefs: (patch: Partial<ReaderPrefs>) =>
    act({ action: 'reader', ...patch }, (ws) => ({ ...ws, reader: { ...DEFAULT_READER, ...ws.reader, ...patch } })),

  collectionCreate: (name: string, parent: string | null, color: GroupColor | null, paths: string[] = []) =>
    act({ action: 'collection-create', name, parent, ...(color ? { color } : {}), ...(paths.length ? { paths } : {}) }),
  collectionUpdate: (collection: Collection, patch: { name?: string; color?: GroupColor | null }) =>
    act({ action: 'collection-update', collection: collection.id, ...patch }, (ws) => ({
      ...ws,
      collections: ws.collections?.map((c) => (c.id === collection.id ? { ...c, ...patch } : c)),
    })),
  collectionMove: (collection: Collection, parent: string | null) =>
    act({ action: 'collection-move', collection: collection.id, parent }, (ws) => ({
      ...ws,
      collections: ws.collections?.map((c) => (c.id === collection.id ? { ...c, parent } : c)),
    })),
  collectionDelete: (collection: Collection) => act({ action: 'collection-delete', collection: collection.id }),
  collectionAdd: (collection: Collection, paths: string[]) =>
    act({ action: 'collection-add', collection: collection.id, paths }, (ws) => ({
      ...ws,
      collections: ws.collections?.map((c) =>
        c.id === collection.id ? { ...c, docs: [...c.docs, ...paths.filter((p) => !c.docs.includes(p))] } : c,
      ),
    })),
  collectionRemove: (collection: Collection, paths: string[]) =>
    act({ action: 'collection-remove', collection: collection.id, paths }, (ws) => ({
      ...ws,
      collections: ws.collections?.map((c) => (c.id === collection.id ? { ...c, docs: c.docs.filter((p) => !paths.includes(p)) } : c)),
    })),
  collectionOpen: (collection: Collection) => {
    reader.rememberActiveScroll()
    return act({ action: 'collection-open', collection: collection.id })
  },
}

export const DEFAULT_READER: ReaderPrefs = { fontSize: 16, width: 'normal', font: 'sans' }

/** Cycle through tabs relative to the active one. */
export function stepTab(delta: number) {
  const ws = state.workspace
  if (!ws?.tabs.length) return
  const index = ws.tabs.findIndex((tab) => tab.path === ws.active)
  const next = ws.tabs[(index + delta + ws.tabs.length) % ws.tabs.length]
  if (next) actions.focus(next.path)
}

export function toggleExpanded(path: string, open?: boolean) {
  const expanded = new Set(state.expanded)
  if (open ?? !expanded.has(path)) expanded.add(path)
  else expanded.delete(path)
  setState({ expanded })
}
