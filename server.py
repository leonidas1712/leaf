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
from workspace import Workspace, DOCUMENT_EXTENSIONS, TEXT_EXTENSIONS
from comments import list_comments, markdown_comments
from reveal import reveal_path
from editing import Editing, ACTIONS
from versions import Changed
from tex import TexProjects
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE = Path(__file__).resolve().parent
# The PDF worker is a module script; browsers refuse it without a JavaScript type.
mimetypes.add_type('text/javascript', '.mjs')
RUNTIME = Path(os.environ.get('LEAF_STATE_DIR', str(Path.home() / '.local/state/leaf-reader')))
WORKSPACE = None
SERVER_INSTANCE = secrets.token_urlsafe(12)
FILE_IDS = {}
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'}
EXTENSIONS = DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS
# Compiled papers run larger than text; everything else keeps the 10 MB reading limit.
PDF_LIMIT = 100 * 1024 * 1024
SKIP = {'node_modules', 'vendor', 'venv', '__pycache__'}
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.RLock()
SESSIONS = {}
COMMANDS = {}
FILES = {}
ROOTS = {}
COMMENT_REVISIONS = set()
EDITOR = None
TEX = None


def editor():
    """Reuse the history store only while its workspace instance remains current."""
    global EDITOR
    if EDITOR is None or EDITOR.workspace is not WORKSPACE:
        if EDITOR is not None:
            EDITOR.store.close()
        EDITOR = Editing(WORKSPACE, FILES)
    return EDITOR


def watch_documents(stop):
    """Observe registered files once per second while the service is running."""
    while not stop.wait(1):
        with LOCK:
            try:
                editor().observe()
            except (OSError, sqlite3.Error):
                # A later observation retries transient storage failures; API writes still report errors.
                continue



def grant_file(path):
    """Grant a read-only identifier for a supported regular file."""
    path = Path(path).expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
        raise ValueError('Choose a supported document or image file.')
    key = FILE_IDS.setdefault(str(path), secrets.token_urlsafe(18))
    FILES[key] = path
    return key


def document_image(document_id, source):
    """Resolve an image a granted document references from its own folder or a subfolder.

    Opening one document is enough to see its figures; nothing above its folder, hidden, or
    reached through a link is served."""
    document = FILES.get(document_id)
    if not document or document.suffix.lower() not in TEXT_EXTENSIONS:
        raise ValueError('Document grant is unavailable.')
    folder = document.parent
    requested = Path(source)
    if not requested.is_absolute() or requested.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError('Choose an image beside the document.')
    try:
        relative = requested.relative_to(folder)
    except ValueError:
        raise ValueError('Images must be in the document folder or below it.') from None
    if any(part in ('..', '.') or part.startswith('.') or part in SKIP for part in relative.parts):
        raise ValueError('Images must be in the document folder or below it.')
    if requested.resolve(strict=True) != requested or not requested.is_file():
        raise ValueError('Image is unavailable.')
    return requested


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


def complete_paths(prefix):
    """List up to fifty safe document/directory suggestions without granting or opening files."""
    expanded = os.path.expanduser(prefix)
    if not expanded.startswith('/'):
        raise ValueError('Completion requires an absolute path or ~/ prefix.')
    candidate = Path(expanded)
    if candidate.is_dir() and not candidate.is_symlink():
        directory, fragment = candidate, ''
    else:
        directory = candidate.parent
        fragment = candidate.name
        while not directory.is_dir() and directory != directory.parent:
            fragment = directory.name
            directory = directory.parent
    if directory.is_symlink() or any(part.startswith('.') or part in SKIP for part in directory.parts[1:]):
        return []
    results = []
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name.startswith('.') or entry.name in SKIP or not entry.name.casefold().startswith(fragment.casefold()) or entry.is_symlink():
                continue
            is_directory = entry.is_dir(follow_symlinks=False)
            if is_directory or (entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in DOCUMENT_EXTENSIONS):
                results.append({'path': str(Path(entry.path).resolve()), 'kind': 'dir' if is_directory else 'file'})
            if len(results) == 50:
                break
    return sorted(results, key=lambda item: (item['kind'] != 'dir', item['path'].casefold()))


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
    paths += [path for collection in WORKSPACE.data['collections'] for path in collection['docs']]
    paths += WORKSPACE.data['pins']
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


def tex_action(data):
    """Enable, disable, build, or switch auto-compile for a LaTeX project; optionally wait for the build."""
    action = data.get('action')
    path = data.get('path')
    if path is not None and not isinstance(path, str):
        raise ValueError('Path must be text.')
    wait = data.get('wait', 0)
    if isinstance(wait, bool) or not isinstance(wait, (int, float)) or not 0 <= wait <= 600:
        raise ValueError('Wait must be 0 to 600 seconds.')
    if action == 'enable':
        if not path:
            raise ValueError('Name the project folder or a .tex file in it.')
        options = {name: data.get(key) for key, name in (('main', 'main'), ('engine', 'engine'), ('bin', 'bin_dir')) if data.get(key)}
        if 'auto' in data:
            options['auto'] = bool(data['auto'])
        status, ticket = TEX.enable(path, **options)
        project = TEX.find(status['root'])
    elif action == 'build':
        project, ticket = TEX.request(path)
    elif action == 'auto':
        return {'project': TEX.set_auto(path, data.get('auto'))}
    elif action == 'disable':
        return TEX.disable(path)
    else:
        raise ValueError('Unknown LaTeX action.')
    if not wait:
        return {'project': project.status(), 'finished': False}
    status, finished = TEX.wait(project, ticket, wait)
    return {'project': status, 'finished': finished}


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
            elif url.path in ('/api/versions', '/api/version'):
                with LOCK:
                    path = editor().path(query.get('path', [''])[0])
                    if url.path == '/api/versions':
                        self.respond(editor().store.history(path))
                    else:
                        self.respond(editor().store.content(path, query.get('id', [''])[0]).encode('utf-8'), content_type='text/plain; charset=utf-8')
            elif url.path == '/api/comments':
                with LOCK:
                    paths = None if query.get('all') == ['true'] else (query.get('path') or [WORKSPACE.data['active']])
                    statuses = query.get('status', ['open', 'working'])
                    if any(status not in ('open', 'working', 'resolved', 'all') for status in statuses):
                        raise ValueError('Unknown comment status.')
                    threads = list_comments(WORKSPACE.data, paths, None if 'all' in statuses else statuses)
                    # format=md adds the same Markdown as `leaf comments --format md`, for export.
                    self.respond({'comments': threads, **({'markdown': markdown_comments(threads)} if query.get('format') == ['md'] else {})})
            elif url.path == '/api/complete':
                self.respond(complete_paths(query.get('path', [''])[0]))
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
                if path.suffix.lower() == '.pdf' and path.stat().st_size > PDF_LIMIT:
                    raise ValueError('PDF exceeds the 100 MB reading limit.')
                if path.suffix.lower() != '.pdf' and path.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError('File exceeds the 10 MB reading limit.')
                with LOCK:
                    raw = path.read_bytes()
                    if path.suffix.lower() in TEXT_EXTENSIONS:
                        try:
                            raw.decode('utf-8')
                            editor().store.record(path, raw)
                        except UnicodeError:
                            pass
                    self.respond(raw, content_type=mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            elif url.path == '/api/image':
                path = document_image(query.get('document', [''])[0], query.get('path', [''])[0])
                if path.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError('Image exceeds the 10 MB reading limit.')
                self.respond(path.read_bytes(), content_type=mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            elif url.path == '/api/tex':
                self.respond({'projects': TEX.statuses()})
            elif url.path == '/api/tex/forward':
                line = query.get('line', [''])[0]
                self.respond(TEX.forward(query.get('path', [''])[0], int(line) if line else None))
            elif url.path == '/api/tex/inverse':
                self.respond(TEX.inverse(query.get('pdf', [''])[0], query.get('page', ['0'])[0], query.get('x', ['0'])[0], query.get('y', ['0'])[0]))
            elif url.path == '/api/tex/page':
                self.respond(TEX.page_sources(query.get('path', [''])[0], query.get('page', ['0'])[0]))
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
        except (ValueError, OSError, sqlite3.Error) as error:
            self.respond({'error': str(error)}, 400)

    def do_POST(self):
        """Queue agent actions and record acknowledgments from the visible reader."""
        if not self.allowed(api=True):
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= (64 * 1024 * 1024 if self.path == '/api/save' else 1024 * 1024):
                raise ValueError('Invalid request size.')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Request must be a JSON object.')
            if self.path == '/api/tex':
                # Outside the workspace lock: waiting for a build must not stall readers.
                self.respond(tex_action(data))
                return
            with LOCK:
                if self.path == '/api/stop':
                    self.respond({'status': 'stopping'})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                elif self.path == '/api/reveal':
                    # Compiled LaTeX PDFs are known to Leaf even before a tab shows them.
                    compiled = [project['pdf'] for project in TEX.statuses() if project['pdfExists']]
                    self.respond(reveal_path(data.get('path'), dict(WORKSPACE.data, files=WORKSPACE.data['files'] + compiled), FILES.values()))
                elif self.path == '/api/save':
                    self.respond(editor().save(data))
                elif self.path == '/api/action' and data.get('action') in ACTIONS:
                    result = editor().action(data)
                    self.respond({'status': 'saved', 'revision': WORKSPACE.data['revision'], 'workspace': WORKSPACE.data, **result})
                elif self.path == '/api/action':
                    previous_revision = WORKSPACE.data['revision']
                    # Documents a live reader has open in its editor, which agent commands keep on screen.
                    editing = {path for reader in live_sessions() for path in reader.get('editing', []) if isinstance(path, str)}
                    workspace = WORKSPACE.action(data, editing)
                    if not data['action'].startswith('comment-'):
                        editor().observe()
                    if data['action'].startswith('comment-') and workspace['revision'] != previous_revision:
                        COMMENT_REVISIONS.add(workspace['revision'])
                        COMMENT_REVISIONS.intersection_update(range(max(0, workspace['revision'] - 1000), workspace['revision'] + 1))
                    self.respond({'status': 'saved', 'revision': workspace['revision'], 'workspace': workspace})
                elif self.path == '/api/sync':
                    session = data['session']
                    revision = data.get('revision', -1)
                    accepted = False
                    same_instance = data.get('instance') == SERVER_INSTANCE
                    if 'view' in data and same_instance:
                        accepted = WORKSPACE.sync(revision, data['view'], view_only=data.get('viewOnly', False))
                    SESSIONS[session] = {'seen': time.time(), 'state': dict(data.get('state', {}), revision=WORKSPACE.data['revision'] if accepted else revision)}
                    result = {'revision': WORKSPACE.data['revision'], 'instance': SERVER_INSTANCE, 'stamps': document_stamps(), 'tex': TEX.statuses()}
                    if not same_instance or (not accepted and revision != WORKSPACE.data['revision']):
                        if same_instance and revision >= 0 and all(r in COMMENT_REVISIONS for r in range(revision + 1, WORKSPACE.data['revision'] + 1)):
                            result['workspace'] = WORKSPACE.data
                        else:
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
        except Changed as error:
            self.respond({'error': 'changed', 'current': error.current}, 409)
        except (ValueError, KeyError, TypeError, OSError, sqlite3.Error) as error:
            self.respond({'error': str(error)}, 400)


def main():
    """Start the local bridge and publish its credentials in a private runtime file."""
    global TOKEN, WORKSPACE, TEX
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
    TEX = TexProjects(RUNTIME)
    TEX.start()
    with LOCK:
        editor().presence()
        editor().observe()
    watch_stop = threading.Event()
    watcher = threading.Thread(target=watch_documents, args=(watch_stop,), daemon=True)
    watcher.start()
    print(f'Leaf is ready at http://127.0.0.1:{args.port}', flush=True)
    if args.open:
        threading.Timer(0.2, webbrowser.open, args=(f'http://127.0.0.1:{args.port}',)).start()
    try:
        server.serve_forever()
    finally:
        watch_stop.set()
        watcher.join(timeout=5)
        TEX.close()
        server.server_close()
        lock.close()


if __name__ == '__main__':
    main()
