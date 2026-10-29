<p align="center">
  <img src="docs/assets/leaf-logo.svg" width="104" alt="Leaf logo">
</p>

<h1 align="center">Leaf</h1>

<p align="center">
  <strong>One calm place to read everything your agents write.</strong><br>
  A local reader for the plans, designs, and architecture notes scattered across your projects,<br>
  driven equally well by you and by your AI agents.
</p>

<p align="center">
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-2f6a4b?style=flat-square">
  <img alt="Python 3.10+" src="https://img.shields.io/badge/python-3.10%2B-3776ab?style=flat-square&logo=python&logoColor=white">
  <img alt="macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-4b5563?style=flat-square">
  <img alt="React 19" src="https://img.shields.io/badge/react-19-149eca?style=flat-square&logo=react&logoColor=white">
  <img alt="Local first" src="https://img.shields.io/badge/local--first-127.0.0.1-2f6a4b?style=flat-square">
  <img alt="Agent operable" src="https://img.shields.io/badge/agents-CLI%20%2B%20JSON-7c3aed?style=flat-square">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6a4b?style=flat-square"></a>
</p>

<p align="center">
  <img src="docs/assets/screenshot-dark.png" alt="Leaf in dark mode: collections and groups in the sidebar, a rollout plan with front matter, a callout and a task list, and an outline on the right" width="100%">
</p>

## Why Leaf

Agents produce a lot of Markdown: plans, designs, runbooks, decision records. It ends up spread across repositories,
scratch folders, and shared boards. Leaf gathers it into one persistent reading workspace in your browser:

- **Collections** link documents from anywhere into logical projects. Nothing moves on disk.
- **Tab groups** keep a project's open documents together, and can be closed and reopened as one.
- **Every action is a command.** Anything you can click, an agent can do with `leaf …`, so "open that in Leaf" just works.
- **Live reload.** When an agent rewrites a document you are reading, it updates in place and keeps your position.
- **Comments.** Select text and leave a comment, Google Docs style. Agents read the threads with `leaf comments`,
  edit the file, and reply or resolve, so you can iterate on a document with any agent.

Leaf never edits, moves, or deletes your files. Comments live in Leaf, not in the documents. For Word documents,
Leaf can save a separate copy with the comments written in as Word comments.

## Features

<table>
<tr>
<td width="50%" valign="top">

**Reading**
- GitHub-flavoured Markdown with callouts, task lists, and tables
- Mermaid diagrams, themed and isolated, with zoom, fit, and source
- Syntax highlighting with one-click copy
- LaTeX (`.tex`, `.bib`) sources, highlighted and commentable like any document
- Read-only PDFs that reload in place when rebuilt; split one beside its sources and it stays put as you change tabs
- Read-only Word documents (`.docx`) shown as pages with their fonts, tables, images, headers, footers, and footnotes; comment on them like any document, and save a copy with the comments as Word comments
- Live LaTeX preview: compiles on change into Leaf's own folder, follows the source you read, double-click the PDF to jump to the line, errors link to their lines; recompile with B and pause auto-compile any time (`leaf tex`)
- YAML front matter shown as a properties block
- Outline that follows your reading position
- Light, dark, or system theme; sans or serif; adjustable size and line length

</td>
<td width="50%" valign="top">

**Organising**
- Nested collections that reference files anywhere, including Aboard boards
- Chrome-style tab groups with colours, collapse, close, and reopen
- Drag documents between folders, collections, groups, and tabs
- ⌘K palette for documents, tabs, collections, and commands; `?` lists every shortcut
- `[` and `]` step through tabs, wrapping within the current tab group
- `e` opens the editor on your selection or where you are reading
- ⌘F find in the document, with every match highlighted
- Path entry that completes from disk, so big repositories stay usable
- One saved workspace shared by every browser window

</td>
</tr>
</table>

<p align="center">
  <img src="docs/assets/screenshot-diagrams-dark.png" alt="A Mermaid sequence diagram and a highlighted JSON block in Leaf's dark theme" width="100%">
</p>

## Quick start

Requires macOS or Linux, Python 3.10 or newer, and a modern browser. Building the interface needs Node.js and npm;
running a built installation needs Python. Three-way merge uses `diff3` (included on macOS; install `diffutils` on Linux).

```sh
git clone https://github.com/leonidas1712/leaf.git ~/leaf
cd ~/leaf
python3 install.py            # builds the web UI and installs the `leaf` command
export PATH="$HOME/.local/bin:$PATH"

leaf ui                       # start Leaf and open the browser
leaf open examples            # add the bundled examples to the sidebar
```

The reader lives at <http://127.0.0.1:18764>. The service keeps running after you close the terminal; after a reboot,
run `leaf ui` again. Use `python3 install.py --skill` to also install the agent skill for Codex.

## Working with agents

Tell an agent to "open the plan in Leaf" and it runs the same commands you would:

```sh
leaf open ~/projects/atlas/PLAN.md            # open a document in a new tab
leaf open ~/projects/atlas/docs               # add a folder to the sidebar
leaf collection new Atlas --color blue --paths ~/projects/atlas/PLAN.md
leaf collection add Atlas aboard://atlas/notes/design.md
leaf group new Review --paths ~/a.md ~/b.md   # group open tabs
leaf heading "Rollback"                       # scroll the live reader to a heading
leaf state --json                             # everything the reader shows, as JSON
```

Every command accepts `--json`. Results distinguish **saved** (written to the workspace) from **applied** (a
connected browser has rendered it), so an agent can tell when you can actually see the change. Run `leaf guide` for
the full agent instructions and see [AGENT-CONTROL.md](AGENT-CONTROL.md) and [API.md](API.md) for the contracts.

## Side-by-side reading

Right-click a tab and choose **Split right**, **left**, **down**, or **up** to show it beside the current document.
Read one document while you edit another: each pane keeps its own mode, outline, and scroll position.
The pane with the green bar has focus. Tabs, shortcuts, and agent commands act on it. Click the other pane to focus it.
When an agent opens a document while you edit, Leaf shows it in the other pane. It splits when needed, and your editor and focus stay where they are.
Drag the divider to resize it, or double-click it to make both panes equal. Press <kbd>|</kbd>, click the × on the divider, or choose **Close split, keep this** on either tab to return to one pane.
Without a split, <kbd>|</kbd> opens your previous document to the right.

```sh
leaf split ~/projects/atlas/notes.md --side right   # notes beside the active document
leaf split --ratio 0.6                              # resize the current split
leaf unsplit                                        # back to one pane, keeping the focused document
```

## Organising documents

| | What it is | Use it for |
| --- | --- | --- |
| **Pinned** | A short, ordered list of documents at the top of the sidebar | Documents you keep coming back to |
| **Folders** | Real directories on disk, mirrored read-only | Browsing a project you want in full |
| **Collections** | Leaf-only, nestable lists of links to documents anywhere | A logical project that spans repos, folders, and boards |
| **Groups** | Sets of open tabs, like Chrome tab groups | The documents you are working with right now |

Pin a document from its tab or sidebar menu, by pressing <kbd>p</kbd>, or by dragging it onto **Pinned**. Drag pins to
reorder them. A pin stays after you close its tab.

Hover a collection and choose **Open** to open its documents as a group. Drag a document onto a collection or group
to add it. Deleting a collection or group never touches the files.

```sh
leaf pin ~/projects/atlas/plan.md             # pin a document; --index N puts it at a position
leaf collection new Plans --parent Atlas
leaf collection open Atlas                    # open Atlas and its sub-collections as a tab group
leaf group close Review                       # put a group's tabs away
leaf group open Review                        # restore them, positions included
```

## Keyboard

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| <kbd>⌘</kbd> <kbd>K</kbd> | Command palette | <kbd>[</kbd> <kbd>]</kbd> | Previous or next tab |
| <kbd>⌘</kbd> <kbd>\\</kbd> | Toggle sidebar | <kbd>1</kbd>–<kbd>9</kbd> | Jump to a tab |
| <kbd>⌘</kbd> <kbd>.</kbd> | Toggle outline | <kbd>x</kbd> | Close tab |
| <kbd>/</kbd> | Filter the sidebar | <kbd>s</kbd> | Toggle Markdown source |
| <kbd>o</kbd> | Open a document by path | <kbd>t</kbd> | Toggle light and dark |
| <kbd>c</kbd> or <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>M</kbd> | Comment on the selection | <kbd>p</kbd> | Pin or unpin the document |
| <kbd>Esc</kbd> <kbd>r</kbd> | Leave the editor and read | <kbd>e</kbd> | Toggle the editor |
| <kbd>⌘</kbd> <kbd>F</kbd> | Find in the document | <kbd>\|</kbd> | Split with the previous document, or close the split |

## Aboard artifacts

With the Aboard CLI installed and connected, open a board file directly:

```sh
leaf open aboard://leaf/notes/ui-plan.md --server aboard
leaf open aboard://leaf/notes/ui-plan.md@v1 --server aboard
leaf refresh --aboard
```

Leaf caches the download privately, shows the board and version above the document, and groups board files under the
board's name unless you pass `--group`. Unpinned files update on explicit refresh; pinned `@vN` files stay fixed.

## Document editing and history

Open a local document and press `e` to edit it. Choose **Split** to see a live Markdown preview beside your text.
Press `⌘S` on macOS (`Ctrl+S` on Linux) to save. An unsaved dot marks tabs with pending edits.
Use **History** in the side panel to inspect versions and compare changes. Hover over an older version to restore it.

If another tool edits the file, Leaf merges separate changes when you save. Overlapping changes show choices beside the affected lines.
Choose which text to keep, review the result, then save. Resolve all conflict markers before saving.

Leaf keeps observed document versions locally. Agents can use their usual file tools and sign changes:

```sh
leaf checkout /path/plan.md --author codex
# Edit the file, then review it.
leaf checkin /path/plan.md --author codex -m 'Clarified the plan'
leaf history /path/plan.md
leaf diff /path/plan.md
leaf restore /path/plan.md v12 --author codex
```

Browser saves reject stale content hashes. Merge and restore record recoverable snapshots.
`leaf merge PATH --base vN --theirs vM` combines versions; overlapping changes need manual resolution.
Aboard cached files remain read-only. Read [the agent guide](AGENT-CONTROL.md#edit-with-document-history) for the full workflow.

History contains full document text. Leaf retains recent snapshots, the latest 200 versions, and active checkout bases.
Observation can miss intermediate native writes. Checkout is advisory, and native tools can race a save's final replacement.
Keep independent backups for important documents.

## Your saved workspace

Tabs, their order and reading positions, groups, collections, sidebar folders, recent paths, and reader settings are
saved automatically and survive restarts. All connected browser windows show the same workspace, and a stale window
cannot overwrite a newer change. If a saved file goes missing, its tab stays; restore the file and run `leaf refresh`.

| Item | Location |
| --- | --- |
| Command | `~/.local/bin/leaf` |
| Saved workspace | `~/.local/state/leaf-reader/workspace.json` |
| Private service connection | `~/.local/state/leaf-reader/connection.json` |
| Document history | `~/.local/state/leaf-reader/history/versions.sqlite3` |
| Service log | `~/.local/state/leaf-reader/server.log` |

## Privacy and security

- The service binds only to `127.0.0.1`, requires a private token, and rejects foreign origins. Do not expose it through a tunnel.
- Leaf reads documents you select, including comment targets, and never uploads them. Relative images load from the document's folder and its subfolders, so a paper opened on its own shows its figures. Drag the handles at an image's sides to resize it, and double-click one to reset; sizes are kept in this browser and never written to the file; remote images stay unloaded, and web links open only when selected.
- Markdown is sanitised, documents cannot run scripts, and Mermaid diagrams render as isolated images.
- Folder scans skip hidden entries, symlinks, and dependency folders, with a 10 MB limit per file and 20,000 files per folder.

## Development

```text
leaf.py        CLI              workspace.py   durable state and revisions
server.py      local service    groups.py      tab groups and collections
web/           React + Vite + TypeScript + Tailwind + shadcn/ui interface
```

```sh
python3 -m unittest discover -p 'test_*.py' -v
npm --prefix web run build
leaf restart                                  # pick up Python changes; refresh the browser for UI changes
```

For an isolated instance that leaves your real workspace alone, run
`LEAF_STATE_DIR=/tmp/leaf-dev python3 server.py --port 18765`.

The installer points the `leaf` command at this checkout, so keep it in place. After moving it or changing Python
installations, run `python3 install.py` again. To uninstall, run `leaf stop` and remove `~/.local/bin/leaf`; your
documents and saved workspace are untouched.

Use `leaf reveal PATH` to show a known document or folder in Finder (macOS) or the file manager (Linux).

## Document comments for agents

Leaf stores comment threads separately from document files. Agents can read, reply, and resolve them through the CLI.

```sh
leaf comments /path/plan.md --format md
leaf comment working k_ID --author codex
# Edit and check the document with your normal tools.
leaf comment resolve k_ID 'Clarified the explanation.' --author codex
```

To export a document's comments, use the download button above the comments: **Copy all as Markdown** or **Download as .md**.
Both include resolved threads, in the same format as `leaf comments PATH --status all`.
For a Word document, **Save copy with Word comments** writes `NAME (Leaf comments).docx` beside it, with the open threads
as Word comments on their passages, so colleagues see them in Word. Agents use `leaf comments FILE.docx --word`.

Use `--all` to list comments across documents. Status changes retain a UTC timeline with the author and optional note.
Quote anchors report current line hints, or detached/ambiguous state when no unique match exists.
See [the agent guide](AGENT-CONTROL.md#address-document-comments) for the full workflow.

## License

[MIT](LICENSE) © 2026 Leonidas Raghav
