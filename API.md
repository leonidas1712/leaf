# Browser and agent API

All API requests require `X-Leaf-Token`. The server injects the token into the page's `leaf-agent-token` meta tag.
Keep the token out of logs and source control. Host and Origin must match the loopback service.

## Canonical workspace

GET `/api/workspace` returns `{workspace, entries, missing}`. Entries contain absolute paths and temporary file grant IDs.
GET `/api/file?id=ID` reads a granted file. Refresh grants after server restart or newly opened files.
POST `/api/action` accepts `{action, ...fields}` and returns `{status:"saved", revision, workspace}`.
All durable UI operations should use this endpoint. The CLI uses the same actions.

The version-1 workspace now includes these additive fields; old workspaces load with defaults:

- `groups`: `{id, name, color, collapsed, closed, saved}` objects. `saved` contains tabs while a group is closed.
- `tabs`: `{path, scroll, group}`. An ungrouped tab has `group:null`.
- `sources`: absolute file path to provenance metadata, currently `{kind:"aboard", server?, board?, file?, version?, fetchedAt?, pinned?}`.
- `reader`: `{fontSize:16, width:"normal", font:"sans"}`.
- `theme`: `light`, `dark`, or `system`.

## Group actions

Group references accept stable IDs or exact unique names. Tab paths are absolute.
Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange.

| Action | Fields | Behavior |
| --- | --- | --- |
| group-create | name, color?, paths? | Create a group; optionally assign already-open tabs |
| group-update | group, name?, color?, collapsed? | Change group appearance; collapsed is boolean |
| group-add | group, paths | Move open tabs into the group; reopen a closed group first |
| group-ungroup | paths | Remove tabs from their groups |
| group-close | group | Save member tabs and positions, then remove them from the open strip |
| group-open | group | Restore saved tabs and focus the first member |
| group-delete | group | Close member tabs and forget the group; source documents remain untouched |
| move-tab | path, index, group? | Move to a zero-based index; group:null ungroups |
| open-file | path, group?, source? | Open a document, optionally assign a group and provenance |
| reader | fontSize?, width?, font? | Set fontSize 12–28, width normal/wide/full, font sans/serif |

Group operations keep member tabs contiguous at their first occurrence. A requested move index can shift to preserve this invariant.
`reorder-tabs` rejects orders that split a group. Reopening a group skips paths already open elsewhere.
Creating a group returns its ID inside the returned workspace's groups array.
Explicit `open-file --group` requires an existing group; it does not infer or create one.

## Browser synchronization

POST `/api/sync` sends `{instance, session, revision, state, view?, viewOnly?}`.
`state` describes the rendered browser for CLI receipts. `view` contains UI state to save.
New clients should send `viewOnly:true`: only tab scroll positions, expanded folders, search, and sidebarWidth are accepted from view.
Tab membership, active tab, theme, source view, and reader settings change through actions.
Legacy full-view sync remains accepted, but cannot replace groups, sources, reader settings, or tab group assignments.
Only matching revisions and server instances accept writes. Stale readers receive canonical hydration.

Responses contain `{revision, instance, stamps, commands, workspace?, entries?, missing?}`.
`stamps` maps each open absolute path to an opaque string (`mtime_ns:size`) or null when unavailable.
Compare stamps for equality only; refetch changed documents while preserving reading positions.
A new server instance requires fresh file grants even if the revision is unchanged.
POST `/api/ack` acknowledges live commands with `{session,id,state,error?}`.
GET `/api/sessions` reports recent readers. Live commands remain `state` and `heading`.

## Aboard cache refresh

The CLI adapter downloads Aboard files through the installed authenticated Aboard CLI.
`open-file.source` records provenance; it does not authorize the HTTP server to fetch remote data.
`source-update {path, source}` updates existing provenance without changing active tabs or reading positions.
It must retain kind, server, board, file, and pinned identity. Source metadata also includes the downloaded SHA-256 digest.
Aboard downloads and refresh remain CLI-only; the server does not run remote-fetch subprocesses.

## Virtual collections

`workspace.collections` is an ordered array of `{id,name,parent,color,docs}`.
`parent` is another collection ID or null; `color` is a group color or null (inherit).
`docs` contains ordered absolute paths. A document may belong to several collections.
Names are unique among siblings, contain 1–120 characters, and cannot contain slash.
References accept stable IDs or root-relative name paths such as `Atlas/Plans`.

| Action | Fields | Behavior |
| --- | --- | --- |
| collection-create | name, parent?, color?, paths? | Create a library collection |
| collection-update | collection, name?, color? | Rename or recolor; null color inherits |
| collection-move | collection, parent, index? | Move under parent ID/path or null; index is the new sibling position |
| collection-delete | collection | Remove the subtree and its references; retain documents and open tabs |
| collection-add | collection, paths, index? | Add supported existing text files; dedupe and optionally position |
| collection-remove | collection, paths | Remove references, including missing files |
| collection-open | collection, recursive? | Open references as a linked tab group; recursive defaults true |

Create/add resolve paths and require existing supported text files. Stored references survive missing files.
Hydration grants collection documents even when not open; missing documents receive entries with errors.
Opening preserves missing references as recoverable tabs and deduplicates recursive documents.
A group linked by `group.collection` is reused. New group names gain a numeric suffix when needed to avoid collisions.
Opening adds collection documents to that group, retaining tabs already there. It focuses the first collection document.
Collection deletion detaches linked groups and removes subtree expansion keys; it never closes those tabs or deletes files.
`expanded` accepts absolute folder paths and `collection:<existing-id>` keys. Arbitrary strings are rejected.
Browser sync cannot replace canonical collections. Use actions for all collection mutations.
`open-file` also accepts `collection` to add the opened document to an existing collection atomically.

GET `/api/complete?path=PREFIX` returns up to 50 `{path,kind:"dir"|"file"}` suggestions.
It requires normal API authentication and origin checks. Supply an absolute path or `~/` prefix.
Suggestions are direct children of the deepest existing directory, filtered by the unfinished name prefix.
Hidden entries, dependency directories, symlinks, and unsupported files are omitted. Completion never adds folders or grants file access.
Collection create/add may include `sources:{absolutePath:provenance}` for added cached Aboard documents.
The CLI resolves aboard:// inputs; browser actions accept local cached paths only.
