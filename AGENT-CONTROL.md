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
