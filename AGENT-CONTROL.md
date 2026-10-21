# Operate Leaf

Leaf provides one persistent reading workspace independent of the current shell directory.
Use `leaf help` to discover commands and `leaf help COMMAND` for argument details.
Bare `leaf` shows help without starting a service. `leaf ui` starts the service and opens a browser.

## Agent commands

Append `--json` for machine-readable success output. Errors use stderr and a nonzero exit code.
Usage errors return 2; operational failures return 1. Successful commands return 0.
`--json` is an output flag, not an input payload.

```sh
leaf status --json
leaf open ~/Documents/notes.md --json
leaf open ~/Documents --no-browser --json
leaf tabs --json
leaf folders --json
leaf recent --json
leaf state --json
leaf focus-tab ~/Documents/notes.md --json
leaf close-tab ~/Documents/notes.md --json
leaf reorder-tabs /path/first.md /path/second.md --json
leaf remove-folder ~/Documents --json
leaf expand-folder ~/Documents --json
leaf collapse-folder '*' --json
leaf search 'release' --json
leaf prefs theme dark --json
leaf prefs --json
leaf view source --json
leaf view formatted --json
leaf scroll --top 400 --json
leaf scroll --by 200 --json
leaf sidebar-width 320 --json
leaf refresh --json
leaf sessions --json
leaf heading 'Installation' --session READER_ID --json
leaf stop --json
leaf start --json
leaf restart --json
```

Paths resolve from the current directory. Quote paths containing spaces. Reordering requires every open tab exactly once.
Closing without a path closes the active tab. Removing a sidebar folder does not delete files or close its tabs.
Opening folders adds them to the workspace. `--no-browser` saves requests without launching a browser.
On macOS, Leaf prefers Chrome and falls back to the default browser. Other supported systems use the default browser.

## Persistence and verification

Tabs, order, active document, scroll positions, folders, recent paths, and preferences persist in the state directory.
Theme changes from either the UI or CLI update the same saved preference. There is no separate per-folder configuration.
All connected readers share the workspace. Stale browser updates cannot overwrite newer revisions.
`status`, `state`, `tabs`, `folders`, `recent`, and preference reads work when stopped.
Mutations start the server if needed. Closing a browser retains tabs. Stopping Leaf retains state.

`saved` confirms durable storage. `applied` confirms a reader synchronized the requested revision.
Neither result proves visual layout quality. Inspect the user's browser when visual proof matters.
Live heading commands require a connected reader; specify `--session` when multiple readers are connected.
Failed or expired live commands must not be described as successful.

The default state directory is `~/.local/state/leaf-reader`. `LEAF_STATE_DIR` overrides it for isolated tests.
Keep `connection.json` private: it contains the local API token. Never print or commit it.
The service binds to loopback, checks browser origins, and reads only granted files.
Do not expose it through a tunnel. Leaf does not edit source documents.

## Skill and development

`leaf skill` prints the portable skill. `python3 install.py --skill` installs it for Codex.
Other agents can read `leaf guide` without installing a skill.
See README.md and AGENTS.md in the source checkout for development instructions.

## Project groups and reader settings

```sh
leaf group list --json
leaf group new 'Project' --color blue --json
leaf open /path/plan.md --group Project --json
leaf group add Project /path/plan.md /path/notes.md --json
leaf group update Project --name 'Project plans' --collapsed true --json
leaf group close 'Project plans' --json
leaf group open 'Project plans' --json
leaf group ungroup /path/plan.md --json
leaf group rm 'Project plans' --json
leaf move-tab /path/plan.md 0 --group none --json
leaf reader --font-size 18 --font serif --width wide --json
leaf reader --json
leaf prefs theme system --json
```

Groups require unique names. `--group` on open requires an existing group.
Closing a group saves its tabs and positions. Removing a group closes its tabs without deleting source files.
Tab groups remain contiguous; moving a tab can adjust its final position to preserve grouping.
See API.md for the browser synchronization and group action contracts.

## Read Aboard files

```sh
leaf open aboard://leaf/notes/ui-plan.md --server aboard --json
leaf open aboard://leaf/notes/ui-plan.md@v1 --server aboard --json
leaf refresh --aboard --json
```

Use a board path, not an invitation or authentication URL. Quote spaces or percent-encode them.
The installed Aboard CLI uses its current authenticated identity and board access. Leaf never reads or copies Aboard credentials.
`--server` selects an Aboard server name or URL; omit it to use Aboard's normal selection rules.
Opening defaults to a group named after the board, creating it when needed. Override with `--group EXISTING_NAME` or `--group none`.
Leaf downloads exact bytes into its private state directory, verifies the digest, and shows board/version provenance.
An unpinned URI selects the latest version when opened or explicitly refreshed. `@vN` stays pinned to that version.
Pinned and unpinned copies use separate cache paths. Repeat opens reuse the same cached tab for the same source identity.
`leaf refresh --aboard` refreshes all saved Aboard sources, including closed tabs, without changing the active document or scroll positions.
Ordinary `leaf refresh` reloads local files only. A failed download retains the previous cached bytes and metadata.
If some refreshes fail, successful sources remain updated; the command reports `partial`, lists failures, and exits 1.
There is no automatic remote polling or browser update-from-board control yet.
Only the selected file is downloaded; relative board images and linked files are not fetched automatically.
