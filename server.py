#!/usr/bin/env python3
"""Serve Leaf and its authenticated, loopback-only agent control interface."""
import argparse
import json
import mimetypes
import os
from pathlib import Path
import secrets
import threading
import time
import webbrowser
import fcntl
from workspace import Workspace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get('LEAF_STATE_DIR', str(Path.home() / '.local/state/leaf-reader')))
WORKSPACE = None
SERVER_INSTANCE = secrets.token_urlsafe(12)
FILE_IDS = {}
EXTENSIONS = {'.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.log', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'}
SKIP = {'node_modules', 'vendor', 'venv', '__pycache__'}
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.RLock()
SESSIONS = {}
COMMANDS = {}
FILES = {}
ROOTS = {}


def grant_file(path):
    """Grant a read-only identifier for a supported regular file."""
    path = Path(path).expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
        raise ValueError('Choose a supported document or image file.')
    key = FILE_IDS.setdefault(str(path), secrets.token_urlsafe(18))
    FILES[key] = path
    return key


def scan_folder(path):
    """Index supported files without following links or dependency directories."""
    path = Path(path).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise ValueError('The path is not a folder.')
    entries = []
    for directory, dirs, names in os.walk(path, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP and not (Path(directory) / d).is_symlink())
        for name in sorted(names):
            file = Path(directory) / name
            if name.startswith('.') or file.is_symlink() or file.suffix.lower() not in EXTENSIONS:
                continue
            entries.append({'path': str(file.relative_to(path)), 'id': grant_file(file)})
            if len(entries) > 20000:
                raise ValueError('Folder exceeds 20,000 supported files. Choose a smaller folder.')
    return entries


def hydrate_workspace():
    """Rebuild transient file grants from saved paths; keep missing tabs recoverable."""
    entries = {}
    missing = []
    for folder in WORKSPACE.data['folders']:
        try:
            for entry in scan_folder(folder):
                path = str(Path(folder) / entry['path'])
                entries[path] = {'path': path, 'id': entry['id']}
        except (ValueError, OSError) as error:
            missing.append({'path': folder, 'error': str(error)})
    paths = WORKSPACE.data['files'] + [tab['path'] for tab in WORKSPACE.data['tabs']]
    for path in paths:
        if path in entries:
            continue
        try:
            entries[path] = {'path': path, 'id': grant_file(path)}
        except (ValueError, OSError) as error:
            entries[path] = {'path': path, 'error': 'File is missing or unavailable. Restore it, then refresh.'}
            missing.append({'path': path, 'error': str(error)})
    return {'workspace': WORKSPACE.data, 'entries': list(entries.values()), 'missing': missing}


def document_stamps():
    """Expose change markers for open documents without reading their contents."""
    stamps = {}
    for tab in WORKSPACE.data['tabs']:
        path = Path(tab['path'])
        try:
            stat = path.stat()
            stamps[str(path)] = str(stat.st_mtime_ns) + ':' + str(stat.st_size)
        except OSError:
            stamps[str(path)] = None
    return stamps


def live_sessions():
    """Return recent browser views without persisting transport identities."""
    return [dict(id=k, **v['state']) for k, v in SESSIONS.items() if time.time() - v['seen'] < 10]


class Handler(BaseHTTPRequestHandler):
    """Reject foreign origins and require a token for all control and file APIs."""

    def log_message(self, *args):
        """Keep document paths and control tokens out of request logs."""

    def respond(self, value, status=200, content_type='application/json'):
        """Send a non-cacheable response without cross-origin access headers."""
        data = json.dumps(value).encode() if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        self.wfile.write(data)

    def allowed(self, api=False):
        """Check the exact host, browser origin, and API bearer token."""
        host = f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host') != host:
            self.respond({'error': 'Invalid host'}, 403)
            return False
        origin = self.headers.get('Origin')
        if (origin and origin != 'http://' + host) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.respond({'error': 'Foreign origin rejected'}, 403)
            return False
        if api and not secrets.compare_digest(self.headers.get('X-Leaf-Token', ''), TOKEN):
            self.respond({'error': 'Authentication required'}, 403)
            return False
        return True

    def do_GET(self):
        """Serve fixed app assets, granted files, sessions, and command receipts."""
        url = urlparse(self.path)
        if not self.allowed(url.path.startswith('/api/')):
            return
        query = parse_qs(url.query)
        try:
            if url.path == '/api/status':
                with LOCK:
                    self.respond({'app': 'leaf', 'version': 2, 'pid': os.getpid(), 'url': f'http://127.0.0.1:{self.server.server_port}', 'workspace': WORKSPACE.data, 'readers': live_sessions()})
            elif url.path == '/api/workspace':
                with LOCK:
                    self.respond(hydrate_workspace())
            elif url.path == '/api/sessions':
                with LOCK:
                    self.respond([dict(id=k, **v['state']) for k, v in SESSIONS.items() if time.time() - v['seen'] < 10])
            elif url.path == '/api/result':
                with LOCK:
                    self.respond(COMMANDS.get(query.get('id', [''])[0], {'status': 'unknown'}))
            elif url.path == '/api/file':
                path = FILES.get(query.get('id', [''])[0])
                if not path or path.resolve() != path or not path.is_file():
                    raise ValueError('File grant is unavailable.')
                if path.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError('File exceeds the 10 MB reading limit.')
                self.respond(path.read_bytes(), content_type=mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            elif url.path == '/api/library':
                root = ROOTS.get(query.get('id', [''])[0])
                if not root:
                    raise ValueError('Unknown folder grant.')
                self.respond(scan_folder(root))
            else:
                name = url.path.lstrip('/') or 'index.html'
                dist = BASE / 'web' / 'dist'
                permitted = name == 'index.html' or name.startswith('assets/')
                if not permitted:
                    self.respond({'error': 'Not found'}, 404)
                    return
                if not (dist / 'index.html').is_file():
                    self.respond(b'Leaf frontend is not built. Run: python3 install.py --build', 503, 'text/plain; charset=utf-8')
                    return
                root = dist.resolve()
                candidate = (root / name).resolve()
                if not candidate.is_relative_to(root) or not candidate.is_file():
                    self.respond({'error': 'Not found'}, 404)
                    return
                data = candidate.read_bytes()
                if name == 'index.html':
                    data = data.replace(b'__LEAF_TOKEN__', TOKEN.encode())
                self.respond(data, content_type=mimetypes.guess_type(name)[0] or 'application/octet-stream')
        except (ValueError, OSError) as error:
            self.respond({'error': str(error)}, 400)

    def do_POST(self):
        """Queue agent actions and record acknowledgments from the visible reader."""
        if not self.allowed(api=True):
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024 * 1024:
                raise ValueError('Invalid request size.')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Request must be a JSON object.')
            with LOCK:
                if self.path == '/api/stop':
                    self.respond({'status': 'stopping'})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                elif self.path == '/api/action':
                    workspace = WORKSPACE.action(data)
                    self.respond({'status': 'saved', 'revision': workspace['revision'], 'workspace': workspace})
                elif self.path == '/api/sync':
                    session = data['session']
                    revision = data.get('revision', -1)
                    accepted = False
                    same_instance = data.get('instance') == SERVER_INSTANCE
                    if 'view' in data and same_instance:
                        accepted = WORKSPACE.sync(revision, data['view'], view_only=data.get('viewOnly', False))
                    SESSIONS[session] = {'seen': time.time(), 'state': dict(data.get('state', {}), revision=WORKSPACE.data['revision'] if accepted else revision)}
                    result = {'revision': WORKSPACE.data['revision'], 'instance': SERVER_INSTANCE, 'stamps': document_stamps()}
                    if not same_instance or (not accepted and revision != WORKSPACE.data['revision']):
                        result.update(hydrate_workspace())
                    pending = []
                    for key, command in COMMANDS.items():
                        if command['session'] == session and command['status'] == 'queued':
                            if time.time() - command['created'] > 20:
                                command['status'] = 'expired'
                            else:
                                command['status'] = 'delivered'
                                pending.append(dict(id=key, **command['command']))
                    result['commands'] = pending
                    self.respond(result)
                elif self.path == '/api/poll':
                    session = data['session']
                    SESSIONS[session] = {'seen': time.time(), 'state': data['state']}
                    pending = []
                    for key, command in COMMANDS.items():
                        if command['session'] == session and command['status'] == 'queued':
                            if time.time() - command['created'] > 20:
                                command['status'] = 'expired'
                            else:
                                command['status'] = 'delivered'
                                pending.append(dict(id=key, **command['command']))
                    self.respond(pending)
                elif self.path == '/api/ack':
                    command = COMMANDS[data['id']]
                    if command['session'] != data['session']:
                        raise ValueError('Session mismatch.')
                    command.update(status='failed' if data.get('error') else 'applied', result=data.get('state'), error=data.get('error'))
                    self.respond({'ok': True})
                elif self.path == '/api/command':
                    active = [key for key, value in SESSIONS.items() if time.time() - value['seen'] < 10]
                    session = data.pop('session', None)
                    if session is None:
                        if len(active) != 1:
                            raise ValueError('Expected one active reader. Use sessions and --session to select one.')
                        session = active[0]
                    if session not in active:
                        raise ValueError('Reader is not connected. Open the local URL first.')
                    if data.get('action') not in ('state', 'heading'):
                        raise ValueError('Use the durable workspace action endpoint for this command.')
                    key = secrets.token_urlsafe(12)
                    COMMANDS[key] = {'session': session, 'command': data, 'status': 'queued', 'created': time.time()}
                    self.respond({'id': key})
                else:
                    self.respond({'error': 'Not found'}, 404)
        except (ValueError, KeyError, TypeError, OSError) as error:
            self.respond({'error': str(error)}, 400)


def main():
    """Start the local bridge and publish its credentials in a private runtime file."""
    global TOKEN, WORKSPACE
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18764)
    parser.add_argument('--open', action='store_true', help='Open the reader in the default browser')
    args = parser.parse_args()
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(RUNTIME / 'server.lock', 'a+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Leaf is already running.')
    WORKSPACE = Workspace(RUNTIME / 'workspace.json')
    connection = RUNTIME / 'connection.json'
    if connection.exists():
        TOKEN = json.loads(connection.read_text())['token']
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    runtime = RUNTIME / 'connection.json'
    fd = os.open(runtime, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'url': f'http://127.0.0.1:{args.port}', 'token': TOKEN, 'pid': os.getpid()}, stream)
    print(f'Leaf is ready at http://127.0.0.1:{args.port}', flush=True)
    if args.open:
        threading.Timer(0.2, webbrowser.open, args=(f'http://127.0.0.1:{args.port}',)).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        lock.close()


if __name__ == '__main__':
    main()
