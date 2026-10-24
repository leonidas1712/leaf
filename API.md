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

## Split panes

`split` is `null` or `{panes:[first, second], focus:0|1, layout:"columns"|"rows", ratio}`.
`first` is the left or top pane. `ratio` is the first pane's share, from 0.2 to 0.8. `panes[focus]` is always `active`.
After every action, the server normalizes the split. If the active document is the other pane's document, focus moves to that pane.
If it is any other document, it replaces the focused pane's document. If either pane's tab closes, the split becomes `null`.

| Action | Fields | Behavior |
| --- | --- | --- |
| split | path?, side?, beside?, ratio? | Show path (default active; opened if needed) on side left/right/up/down (default right) of beside, and focus it |
| split-resize | ratio | Change the first pane's share; requires a split |
| unsplit | path? | Return to one pane showing path (must be a pane) or the focused document |

Without `beside`, the other pane shows the active tab. If the target is the active tab, it shows the most recent other open tab.
Closing the active tab during a split focuses the other pane, which then becomes the only pane.
The split is durable workspace state, so every connected reader shows the same layout. Browsers change it only through actions.

Readers report `editing` in their sync `state`. It lists the paths open in an editor or holding unsaved changes, and never their contents.
Actions sent with `origin:"agent"` keep a document from that list on screen when they would show a different document.
The other document goes into the other pane, and the action creates a split if needed. `active` and focus stay on the user's document.
`replace:true` turns this protection off. `open-file` with `background:true` adds the tab without changing `active`.
The CLI sends `origin:"agent"` with every workspace action. Browser actions omit it.

## Pins

`pins` is an ordered list of absolute document paths shown at the top of the sidebar. It is independent of tabs:
pinning never opens a document, and closing a tab keeps its pin.

| Action | Fields | Effect |
| --- | --- | --- |
| pin | path, index? | Pin a supported text document at index (default the end), or move an existing pin to index |
| unpin | path | Remove the pin; the document and its tab are unchanged |

`index` counts from 0 in the list without the pin being moved. A missing file, a folder, or an unsupported type is rejected.
Pinned paths are granted like collection documents, so a pin whose file disappeared is reported in `missing`.

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

## Document comments

`workspace.comments` contains persistent threads in the same atomic workspace revision as tabs and collections.
Browser sync cannot write comments. Action responses include canonical comments without derived locations.
A sync response after only comment changes includes `workspace` without `entries` or `missing`.
Clients must retain existing grants in that case. A new server instance still forces full hydration.

Each thread has `id`, absolute `path`, nullable `anchor`, `body`, `author`, `created`, `updated`,
`status`, `statusBy`, `statusAt`, and `replies`. Edited bodies also have `edited`.
An anchor has `quote` and optional `prefix`, `suffix`, and `heading`.
Each reply has `id`, `author`, `body`, `created`, optional `edited`, and optional `status`.
All timestamps use ISO-8601 UTC. Status changes append timeline entries, even without a note.

| Action | Fields | Behavior |
| --- | --- | --- |
| `comment-add` | path, body, anchor?, author? | Validate an existing supported text document and append a thread |
| `comment-edit` | id, body, reply? | Edit the thread body or a named reply |
| `comment-reply` | id, body, author? | Append a reply |
| `comment-status` | id, status, author?, note? | Set open/working/resolved and append a status event |
| `comment-delete` | id, reply? | Delete a thread or named reply, never the document |
| `comment-anchor` | id, anchor | Replace the selector, or use null for the whole document |

`GET /api/comments` requires the same local authentication as other API routes.
It returns `{comments: [...]}` with derived `location: {state, line, endLine}` on each thread.
Repeat `path` to select documents. Without paths, it selects the active document. `all=true` selects all documents.
Repeat `status` to select states. The default is open plus working. `status=all` includes resolved threads.
Location states are attached, changed, ambiguous, and detached. Lines are one-based and null without a unique quote match.
Document-level comments have attached state and null lines. Missing files do not delete threads.
Quote matching collapses whitespace and retries with simplified Markdown removal while retaining source offsets.
Prefix and suffix distinguish duplicate matches when one candidate has a unique highest context score.
The location reader is bounded to 10 MiB per document. It reports detached for unreadable or oversized text.

Quote-only creation fills empty prefix, suffix, and heading fields when the simplified Markdown view has a unique match.
Explicit nonempty context remains unchanged. Generated prefix and suffix contain at most 32 characters each.
The heading trail includes Markdown heading ancestors and excludes fenced code.
If exact matching fails, the locator can identify a changed passage from its old surroundings.
Both prefix and suffix must contain at least 12 characters. The prefix must occur exactly once.
The suffix must follow within `quote.length * 3 + 200` characters, with a nonempty passage between them.
This fallback returns `changed` with current lines. It never changes the stored quote or deletes the thread.

## Reveal in the system file manager

`POST /api/reveal` accepts `{path: "/absolute/path"}` with the usual token, Host and Origin checks.
It returns `{status: "revealed"}` when the system command succeeds. Invalid paths and launch failures return HTTP 400 with an error.
This operation does not change the workspace or its revision.

Allowed targets are existing workspace files, tabs, folders, collection documents, and subfolders inside a current sidebar folder.
A granted file inside a current sidebar folder is also allowed. Unlisted files inside a folder remain disallowed until granted.
Resolved paths enforce containment. Symlinks cannot grant access outside a sidebar folder.
macOS runs `open -R PATH`. Linux runs `xdg-open` on the folder or the parent of a file.
Commands use argument lists without a shell. The response confirms command success, not visible file-manager state.

## Editing and observed versions

All routes use the existing Host, Origin, and token checks. Paths must name known supported text documents.
History lives in private `history/versions.sqlite3`; source documents remain on disk.

- `GET /api/versions?path=ABS`: `{current:{hash,version},versions:[metadata]}`, newest first. It observes disk before responding.
- `GET /api/version?path=ABS&id=vN`: exact UTF-8 snapshot text, scoped to the path.
- `POST /api/save`: `{path,base,text,author?,note?}`. `base` is `sha256:` plus the lowercase digest of exact bytes.
- Successful save: `{version:metadata}`. Metadata includes `id,hash,at,author,kind,note,added,removed`.
- Stale save: HTTP 409 `{error:"changed",current:{hash,version,text}}`. The proposed text is not written.
- Invalid, unknown, read-only, oversized, or non-UTF-8 targets return HTTP 400.

History metadata adds `base:boolean` for versions pinned by active checkouts. Timestamps use ISO-8601 UTC.
`kind` is `external`, `save`, `checkin`, or `restore`. Checkin may annotate an unchanged anonymous snapshot.
Consecutive identical bytes do not create another version. IDs are database-wide and remain scoped to their document in requests.

Editing actions use `POST /api/action`:

| Action | Fields | Result additions |
| --- | --- | --- |
| `edit-start` | path, author | presence, optional warning |
| `edit-end` | path, author | clears only that author's checkout |
| `checkin` | path, author, note? | status ok/overwrote, version, base, overwritten, theirs, message |
| `diff` | path, author?, left?, right? | unified diff, base, current |
| `merge` | path, author?, base?, theirs? | status merged/conflicts, version, conflicts, theirs |
| `restore` | path, version, base hash, author?, note? | version |

Action responses include the current workspace and revision. `workspace.editing` maps paths to `{author,since,base}`.
Multiple authors can retain bases; this map displays the most recent declaration. Presence changes may advance the workspace revision.
Browser sync cannot replace presence. Presence is advisory and survives service restarts until released or checked in.
Save defaults to author `you`. CLI commands pass their explicit or environment-selected author.
Restore reads the selected snapshot and uses the supplied hash for CAS. Merge snapshots its result before establishing a new checkout base.

The save request limit allows JSON escaping overhead; decoded text is limited to 10 MiB of UTF-8.
The service serializes its writes, rechecks disk immediately before replacement, and preserves file mode.
Native file tools do not share this lock. An external write racing the final replacement remains possible.
See AGENT-CONTROL.md for observation, retention, conservative overwrite checks, and recovery steps.
