# Leaf

Leaf is a local document reader with a persistent workspace and an agent control interface.
Your documents can live anywhere. Opening a folder adds it to the workspace without closing your tabs.

## Install from a checkout

Requires macOS or Linux, Python 3.10 or newer, and a modern browser. There are no Python packages to install. Building the React UI requires Node.js and npm; running a built installation does not.
Windows is not supported yet because the service uses POSIX process locks.

Clone this repository into a permanent directory, then run:

```sh
cd leaf
python3 install.py
# Optional: install the Codex agent skill too
python3 install.py --skill
```

Add `~/.local/bin` to your shell PATH if it is not already present:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer builds the frontend with `npm ci` and `npm run build` when `web/package.json` exists and built assets are missing.
Use `python3 install.py --build` to rebuild after frontend changes.
Use `--skip-build` to install only the launcher; this requires existing assets to read documents.
The installer finds npm on PATH or in a local nvm installation. Build failures stop installation.
The server serves only web/dist. A missing build displays installation instructions.

The installer creates a launcher pointing at this checkout and its Python interpreter.
Keep the checkout in place. After moving it or changing Python installations, run the installer again.
Use `--bin-dir PATH` for another executable directory.
Updates take effect after `leaf restart`; refresh the browser after UI changes.
To uninstall, run `leaf stop`, remove the installed launcher, and remove the optional skill symlink.
Your documents and saved workspace remain untouched.

## Everyday commands

Run these commands from any directory:

```sh
leaf                       # Show help
leaf help open             # Explain one command
leaf ui                    # Start Leaf and open the browser
leaf guide                 # Read agent instructions
leaf skill                 # Print the portable agent skill
leaf prefs                 # Show persistent preferences
leaf prefs theme dark      # Save dark mode as your default
leaf open README.md        # Open a file relative to this terminal directory
leaf open ~/Documents      # Add a folder without closing tabs
leaf open one.md two.md    # Open several files
leaf status                # Show service and workspace status
leaf tabs                  # Show open tabs and reading positions
leaf folders               # Show folders in the sidebar
leaf recent                # Show recent files and folders
leaf stop                  # Stop the server, keeping saved state
leaf start                 # Start the server in the background
leaf restart               # Restart and retain the workspace
```

The server runs independently of the terminal. Closing the terminal does not stop it.
After a computer restart, run `leaf ui` to continue. Leaf does not install a login service.
The browser address remains <http://127.0.0.1:18764>.

`leaf open` starts the server when needed. It opens a browser when no reader is connected.
Use `leaf open PATH --no-browser` to save an open request without launching Chrome.
`leaf status`, `leaf state`, `leaf tabs`, `leaf folders`, and `leaf recent` also work while the server is stopped.

## Your saved workspace

Leaf saves these items automatically:

- Open tabs, their order, and the active document.
- Each tab's reading position.
- Sidebar folders and expanded branches.
- Recent files and folders.
- Theme, source view, search text, and sidebar width.

All connected readers show the same workspace. Browser windows are views of that workspace, not separate projects.
A stale browser update cannot overwrite a newer revision.
Closing a document tab persists its closure. Closing the browser retains the tabs for your next visit.

The footer shows **Saved · Agent connected** after synchronization.
Changes made while disconnected are not saved. Reconnection restores the last server state.
If a saved file is missing, its tab remains. Restore the file and refresh Leaf to read it again.

## Open documents from the interface

1. Click **Open files** or **Open folder**.
2. Paste an absolute local path or a path that starts with `~/`.
3. Click **Open**.

The sidebar also contains recent files and folders. Select one to reopen it.
You can ask your agent to open a path instead of entering it yourself.

## Reading tools

Markdown supports headings, tables, lists, links, code blocks, and local images.
Mermaid blocks render offline with zoom, fit, source, and dark-mode controls.
Invalid diagrams retain their source with an error message.
Text, JSON, YAML, CSV, and log files use a plain-text view.
PDF, Word, and mathematical notation are not supported yet.

The theme button and `leaf prefs theme dark` change the same saved preference.
Your selected theme applies after browser and service restarts. Use `leaf prefs theme light` to change it back.

The heading outline navigates within a document. **Source** shows raw Markdown.
Drag tabs, or use the arrow buttons, to change their order.
**Print** opens the browser print dialog, including PDF output.

Leaf is a reader. It does not edit, rename, move, or delete document files.

## Locations

| Item | Location |
| --- | --- |
| Source | Your checkout (this installation: `~/leaf/`) |
| Command | `~/.local/bin/leaf` |
| Saved workspace | `~/.local/state/leaf-reader/workspace.json` |
| Private service connection | `~/.local/state/leaf-reader/connection.json` |
| Service log | `~/.local/state/leaf-reader/server.log` |
| Upgrade backup | `~/.local/state/leaf-reader/backups/` |

In this installation, the old app paths remain compatibility symlinks to `~/leaf`.
Documents remain in their original locations. State contains paths and interface settings, not copies of document contents.
The state file uses atomic replacement and owner-only file permissions. Python 3 is the only runtime dependency.

## Agent use

See [AGENT-CONTROL.md](AGENT-CONTROL.md) for the command contract and verification rules.
Append `--json` to commands for structured output. Bare `leaf` and `leaf help` do not start the service.
`leaf guide` and `leaf skill` work while stopped.

The CLI distinguishes a durable **saved** result from browser-confirmed **applied** behavior.

## Local access

The server binds only to `127.0.0.1` and requires a private API token.
It rejects foreign browser origins. Do not publish the connection file or expose the service through a tunnel.
Document scripts are disabled. Leaf does not upload documents to external services or load remote images.
External web links open when selected.

Folder scans skip hidden entries, symlinks, and common dependency folders. Each file has a 10 MB reading limit.
Folder scans support up to 20,000 files. Choose a smaller folder if this limit is exceeded.

## Development

`workspace.py` owns durable state and revision checks. `server.py` owns local transport and file grants.
`leaf.py` implements the CLI. The React bridge synchronizes the browser with the saved workspace.
`web/src/` implements the React reader, browser synchronization, and Mermaid rendering.

Run validation from the app directory:

```sh
python3 -m unittest discover -p 'test_*.py' -v
npm --prefix web run build
```

Frontend dependencies and exact versions are recorded in `web/package.json` and `web/package-lock.json`.
Their upstream license files are installed under `web/node_modules/` by npm.

## Project groups and typography

Use `leaf group new Project --color blue`, then `leaf open plan.md --group Project`.
`leaf group close Project` saves the group's tabs; `leaf group open Project` restores them.
`leaf group list --json` lists stable IDs and saved groups. Group removal never deletes document files.
Use `leaf reader --font-size 18 --width wide --font serif` to save reader settings.
`leaf prefs theme system` follows the browser's system color scheme in the React UI.
See [API.md](API.md) for frontend integration and action contracts.
