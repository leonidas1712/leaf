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
