---
name: leaf
description: Operate the local Leaf document reader through its CLI. Use when asked to open documents or folders in Leaf, manage reading tabs, change preferences, inspect saved state, or start and stop the reader.
---

# Leaf

Run `leaf guide` for the current operation contract. Run `leaf help` and `leaf help COMMAND` to discover arguments.
If `leaf` is absent, install from the Leaf checkout with `python3 install.py`.

Use the CLI rather than browser automation for supported actions. Append `--json` for structured output.

```sh
leaf status --json
leaf open /absolute/path/document.md --json
leaf open /absolute/path/folder --json
leaf tabs --json
leaf focus-tab /absolute/path/document.md --json
leaf close-tab /absolute/path/document.md --json
leaf prefs theme dark --json
leaf group new Project --color blue --json
leaf open /absolute/path/plan.md --group Project --json
leaf group close Project --json
leaf group open Project --json
leaf reader --font-size 18 --width wide --json
leaf restart --json
```

Paths resolve from the shell's working directory. Quote paths containing spaces. Opening a folder adds it without closing tabs.
`leaf ui` opens the browser. Bare `leaf` displays help. All browser readers share one persistent workspace.

A `saved` result confirms disk persistence only. An `applied` result confirms that a browser synchronized the revision.
Inspect `leaf state --json` for canonical state. Use `leaf sessions --json` for live readers and rendered state.
For visual correctness, inspect the user's browser after the command. Do not claim visual success from a saved result.

Use `leaf heading HEADING --session ID --json` when targeting one live reader.
Do not expose the private connection token or commit runtime state, document contents, or screenshots.
Leaf reads documents; it does not modify, move, or delete source documents.

Groups require unique names. Closing saves member tabs; removing a group closes tabs without deleting documents.
Read API.md in the source checkout before changing synchronization or group behavior.

For board files use `leaf open aboard://BOARD/path/file.md --server SERVER --json`.
Use `@vN` to pin a version. Otherwise the latest version is selected at open or explicit refresh.
`leaf refresh --aboard --json` refreshes saved board sources without changing tab focus.
Aboard must already be installed, connected, and authorized for that board. Leaf does not join boards or handle credentials.
Only the requested file is fetched; relative board attachments are not automatic.

Collections are virtual library folders, distinct from open tab groups. Use `leaf collection` subcommands.
Create with `leaf collection new NAME --paths PATH...`; nest with `--parent ROOT/CHILD`.
`leaf collection open ROOT/CHILD` opens its recursive documents as a linked group.
`leaf open PATH --collection ROOT/CHILD` opens and adds one document.
Deleting a collection removes its subtree references only; files and open tabs remain.
