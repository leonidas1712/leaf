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
