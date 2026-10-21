#!/usr/bin/env python3
"""Leaf: a persistent local reading workspace, usable from any directory."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get('LEAF_STATE_DIR', str(Path.home() / '.local/state/leaf-reader')))


def request(path, data=None, timeout=3):
    """Call the authenticated local service without printing credentials."""
    connection = json.loads((RUNTIME / 'connection.json').read_text())
    req = Request(connection['url'] + path, data=json.dumps(data).encode() if data is not None else None,
                  headers={'X-Leaf-Token': connection['token'], 'Content-Type': 'application/json'})
    with urlopen(req, timeout=timeout) as response:
        return json.load(response)


def running():
    """Return verified service state, or None when this installation is stopped."""
    try:
        result = request('/api/status')
        return result if result.get('app') == 'leaf' else None
    except (OSError, ValueError, URLError):
        return None


def start():
    """Start one detached server and wait for authenticated readiness."""
    current = running()
    if current:
        return current
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(RUNTIME / 'server.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'ab', buffering=0) as log:
        process = subprocess.Popen([sys.executable, str(BASE / 'server.py')], stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True, close_fds=True)
    for _ in range(50):
        current = running()
        if current:
            return current
        if process.poll() is not None:
            raise RuntimeError(f'Leaf did not start. Inspect {RUNTIME / "server.log"}. No other process was stopped.')
        time.sleep(.1)
    raise RuntimeError('Leaf did not become ready within five seconds.')


def stop():
    """Stop only the authenticated Leaf service; preserve its saved workspace."""
    current = running()
    if not current:
        return {'status': 'stopped'}
    # A live state request lets active readers submit their latest view before shutdown.
    receipts = []
    for reader in current['readers']:
        if 'revision' in reader:
            try:
                receipts.append(request('/api/command', {'action': 'state', 'session': reader['id']})['id'])
            except HTTPError:
                pass
    deadline = time.monotonic() + 3
    while receipts and time.monotonic() < deadline:
        receipts = [key for key in receipts if request('/api/result?id=' + key)['status'] not in ('applied', 'failed', 'expired')]
        if receipts:
            time.sleep(.1)
    request('/api/stop', {})
    for _ in range(50):
        if not running():
            return {'status': 'stopped', 'workspace': str(RUNTIME / 'workspace.json')}
        time.sleep(.1)
    raise RuntimeError('Leaf has not stopped yet. No process was forcibly killed.')


def open_browser(url):
    """Open Chrome on macOS, falling back to the configured browser elsewhere."""
    if sys.platform == 'darwin':
        opened = subprocess.run(['open', '-a', 'Google Chrome', url], capture_output=True)
        if opened.returncode:
            subprocess.run(['open', url], check=True)
    else:
        import webbrowser
        webbrowser.open(url)


def await_display(revision):
    """Distinguish a durable save from confirmed rendering by a connected browser."""
    for _ in range(25):
        info = request('/api/status')
        readers = [reader for reader in info['readers'] if reader.get('revision', -1) >= revision]
        if readers:
            return {'status': 'applied', 'revision': revision, 'readers': [r['id'] for r in readers]}
        if not info['readers']:
            return {'status': 'saved', 'revision': revision, 'message': 'The workspace will appear when a reader connects.'}
        time.sleep(.2)
    return {'status': 'saved', 'revision': revision, 'message': 'Saved to disk; browser rendering is not yet confirmed.'}


def make_parser():
    """Describe supported commands and reject mistakes before contacting the server."""
    parser = argparse.ArgumentParser(prog='leaf', description=__doc__, epilog='Start reading: leaf ui | Open a document: leaf open README.md | Agent instructions: leaf guide')
    parser.add_argument('--version', action='version', version='Leaf 0.1.0')
    parser.add_argument('--json', action='store_true', help='Print machine-readable results')
    commands = parser.add_subparsers(dest='action', metavar='COMMAND')
    descriptions = {
        'ui': 'Start Leaf and open the browser', 'start': 'Start the background service',
        'stop': 'Stop the service, retaining your workspace', 'restart': 'Restart with saved tabs and folders',
        'status': 'Show service status and installation paths', 'state': 'Show the saved workspace',
        'tabs': 'List open tabs', 'folders': 'List sidebar folders', 'recent': 'List recent paths',
        'sessions': 'List connected browser readers', 'open': 'Open files or add folders',
        'open-file': 'Open one document', 'open-folder': 'Add a sidebar folder',
        'close-tab': 'Close a tab (defaults to active)', 'close': 'Alias for close-tab',
        'focus-tab': 'Activate an open tab', 'focus': 'Alias for focus-tab',
        'reorder-tabs': 'Set tab order using every open path', 'remove-folder': 'Remove a sidebar folder',
        'expand-folder': 'Expand a folder (or "*")', 'collapse-folder': 'Collapse a folder (or "*")',
        'search': 'Filter the document sidebar', 'theme': 'Save the light or dark preference',
        'view': 'Select formatted or source view', 'heading': 'Navigate to a heading in a live reader',
        'scroll': 'Set or adjust the reading position', 'sidebar-width': 'Set sidebar width in pixels',
        'refresh': 'Reload documents', 'prefs': 'Show or set persistent preferences',
        'guide': 'Read the agent operation guide', 'skill': 'Print the portable agent skill',
        'help': 'Show help for a command',
    }
    for name, description in descriptions.items():
        child = commands.add_parser(name, help=description, description=description)
        child.add_argument('--json', action='store_true', default=argparse.SUPPRESS, help='Print machine-readable results')
        child.set_defaults(paths=[], session=None, no_browser=False)
        if name in ('open', 'reorder-tabs'):
            child.add_argument('paths', nargs='+', metavar='PATH')
        elif name in ('close', 'close-tab', 'search', 'help'):
            child.add_argument('paths', nargs='?', default=None, metavar='VALUE')
        elif name in ('open-file', 'open-folder', 'focus', 'focus-tab', 'remove-folder', 'expand-folder', 'collapse-folder', 'heading'):
            child.add_argument('paths', metavar='PATH')
        elif name in ('theme', 'view'):
            child.add_argument('paths', choices=('light', 'dark') if name == 'theme' else ('source', 'formatted'))
        elif name == 'sidebar-width':
            child.add_argument('width', type=int, choices=range(180, 601), metavar='180..600')
        elif name == 'scroll':
            group = child.add_mutually_exclusive_group(required=True)
            group.add_argument('--top', type=float)
            group.add_argument('--by', type=float)
        elif name == 'prefs':
            child.add_argument('key', nargs='?', choices=['theme'])
            child.add_argument('value', nargs='?', choices=['light', 'dark'])
        if name in ('open', 'open-file', 'open-folder', 'ui'):
            child.add_argument('--no-browser', action='store_true', help='Do not launch a browser')
        if name == 'heading':
            child.add_argument('--session', help='Connected reader ID')
    return parser, commands.choices


def output(result, as_json=False):
    """Emit stable JSON for agents and readable fields for terminal users."""
    if as_json:
        print(json.dumps(result, indent=2))
    elif isinstance(result, dict):
        for key, value in result.items():
            print(f'{key}: {json.dumps(value) if isinstance(value, (dict, list)) else value}')
    elif isinstance(result, list):
        print('\n'.join(str(value) for value in result) or '(empty)')
    else:
        print(result)


def main():
    """Dispatch service lifecycle, workspace, and live navigation commands."""
    parser, commands = make_parser()
    args = parser.parse_args()
    if not args.action:
        parser.print_help()
        return
    if args.action == 'help':
        if args.paths and args.paths not in commands:
            parser.error('Unknown command: ' + args.paths)
        (commands[args.paths] if args.paths else parser).print_help()
        return
    if args.action in ('guide', 'skill'):
        path = BASE / ('AGENT-CONTROL.md' if args.action == 'guide' else 'skills/leaf/SKILL.md')
        content = path.read_text()
        output({'path': str(path), 'content': content} if args.json else content, args.json)
        return
    args.paths = [args.paths] if isinstance(args.paths, str) else (args.paths or [])
    extra = {}
    for key in ('width', 'top', 'by'):
        if getattr(args, key, None) is not None:
            extra[key] = getattr(args, key)
    if args.action == 'reorder-tabs':
        extra['paths'] = args.paths
    if args.action == 'prefs':
        if args.value and not args.key:
            parser.error('Provide a preference name before its value.')
        if not args.value:
            info = running()
            from workspace import Workspace
            workspace = info['workspace'] if info else Workspace(RUNTIME / 'workspace.json').data
            output({'theme': workspace['theme']}, args.json)
            return
        args.action, args.paths = 'theme', [args.value]
    action = args.action
    if action == 'stop':
        result = stop()
    elif action == 'restart':
        stop()
        info = start()
        result = {'status': 'running', 'url': info['url'], 'message': 'Saved workspace retained. Existing readers reconnect automatically.'}
    elif action in ('start', 'ui'):
        info = start()
        if action == 'ui' and not args.no_browser:
            open_browser(info['url'])
        result = {'status': 'running', 'url': info['url'], 'stateDirectory': str(RUNTIME)}
    elif action in ('status', 'state', 'tabs', 'folders', 'recent'):
        info = running()
        if info:
            workspace = info['workspace']
        else:
            from workspace import Workspace
            workspace = Workspace(RUNTIME / 'workspace.json').data
        if action == 'tabs':
            result = {'active': workspace['active'], 'tabs': workspace['tabs']}
        elif action == 'folders':
            result = workspace['folders']
        elif action == 'recent':
            result = {'files': workspace['recentFiles'], 'folders': workspace['recentFolders']}
        elif action == 'state':
            result = workspace
        else:
            result = {'status': 'running' if info else 'stopped', 'url': info['url'] if info else 'http://127.0.0.1:18764',
                      'pid': info['pid'] if info else None, 'active': workspace['active'], 'tabs': len(workspace['tabs']),
                      'folders': len(workspace['folders']), 'revision': workspace['revision'],
                      'connectedReaders': len(info['readers']) if info else 0, 'stateDirectory': str(RUNTIME), 'appDirectory': str(BASE)}
    elif action == 'sessions':
        result = request('/api/sessions')
    elif action == 'heading':
        start()
        command = {'action': action, 'path': args.paths[0] if args.paths else ''}
        if args.session:
            command['session'] = args.session
        receipt = request('/api/command', command)
        for _ in range(100):
            result = request('/api/result?id=' + receipt['id'])
            if result['status'] in ('applied', 'failed', 'expired'):
                result.pop('command', None)
                break
            time.sleep(.2)
        else:
            result = {'status': 'unconfirmed', 'message': 'No browser acknowledgment. Inspect before retrying.'}
        if result['status'] != 'applied':
            output(result, args.json)
            raise SystemExit(1)
    else:
        info = start()
        if action == 'open':
            if not args.paths:
                if not args.no_browser:
                    open_browser(info['url'])
                print(json.dumps({'status': 'running', 'url': info['url']}))
                return
            commands = [{'action': 'open-folder' if Path(p).expanduser().is_dir() else 'open-file', 'path': str(Path(p).expanduser().resolve())} for p in args.paths]
        else:
            command = dict(extra, action={'close': 'close-tab', 'focus': 'focus-tab'}.get(action, action))
            if args.paths:
                path = args.paths[0]
                if command['action'] in ('open-file', 'open-folder', 'focus-tab', 'close-tab', 'remove-folder') or (command['action'] in ('expand-folder', 'collapse-folder') and path != '*'):
                    path = str(Path(path).expanduser().resolve())
                command['path'] = path
            if command['action'] == 'reorder-tabs' and 'paths' in command:
                command['paths'] = [str(Path(p).expanduser().resolve()) for p in command['paths']]
            commands = [command]
        for command in commands:
            saved = request('/api/action', command, timeout=30)
        if action in ('open', 'open-file', 'open-folder') and not args.no_browser and not request('/api/status')['readers']:
            open_browser(info['url'])
            time.sleep(.5)
        result = await_display(saved['revision'])
        result['active'] = saved['workspace']['active']
        result['tabs'] = [tab['path'] for tab in saved['workspace']['tabs']]
    output(result, args.json)


if __name__ == '__main__':
    try:
        main()
    except HTTPError as error:
        with error:
            print(error.read().decode(), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, RuntimeError, URLError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
