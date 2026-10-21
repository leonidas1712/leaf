"""Fetch authorized Aboard document versions into a private, read-only Leaf cache."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit
from workspace import TEXT_EXTENSIONS


def parse_uri(uri):
    """Parse a board path and optional pinned version without accepting traversal or flags."""
    parsed = urlsplit(uri)
    board = unquote(parsed.netloc)
    name = unquote(parsed.path.lstrip('/'))
    match = re.search(r'@v([1-9][0-9]*)$', name)
    version = int(match.group(1)) if match else None
    if match:
        name = name[:match.start()]
    if parsed.scheme != 'aboard' or parsed.query or parsed.fragment or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', board):
        raise ValueError('Use aboard://BOARD/path/document.md, optionally ending in @vN.')
    if not name or name.startswith('-') or '\\' in name or any(part in ('', '.', '..') for part in name.split('/')) or any(ord(c) < 32 for c in name):
        raise ValueError('Aboard file path is invalid.')
    if Path(name).suffix.lower() not in TEXT_EXTENSIONS:
        raise ValueError('Choose a supported text document from Aboard.')
    return board, name, version


def call_aboard(arguments):
    """Run the installed CLI with its existing session identity; never handle credentials."""
    executable = shutil.which('aboard')
    if not executable:
        raise RuntimeError('Aboard CLI is required. Install and connect Aboard, then retry.')
    try:
        result = subprocess.run([executable, *arguments, '--json'], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('Aboard download timed out; the previous cached file was retained.') from error
    if result.returncode:
        raise RuntimeError('Aboard could not read the file. Check board membership, server selection, and file/version with aboard file show.')
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise RuntimeError('Aboard returned an invalid JSON response.') from error


def fetch_document(uri, runtime, server=None, runner=call_aboard):
    """Download an exact version, verify its digest, and atomically replace only Leaf's cache."""
    board, name, pinned = parse_uri(uri)
    flags = ['--board', board] + (['--server', server] if server else [])
    shown = runner(['file', 'show', name, *flags])
    canonical_server = shown['server']['url']
    record = shown['file']
    version = pinned or record['latest']['version']
    identity = json.dumps([canonical_server, board, name, pinned], separators=(',', ':'))
    key = hashlib.sha256(identity.encode()).hexdigest()
    directory = Path(runtime).resolve() / 'aboard' / key
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / Path(name).name
    # Download to a fresh path; Aboard never gets permission to overwrite a user document.
    with tempfile.TemporaryDirectory(prefix='.fetch-', dir=directory) as temporary:
        staged = Path(temporary) / target.name
        result = runner(['file', 'get', record['id'], str(staged), '--board', board,
                         '--server', canonical_server, '--version', str(version)])
        if result.get('version') != version or result.get('server', {}).get('url') != canonical_server or result.get('board') != board:
            raise RuntimeError('Aboard returned a different source or version; cached file was retained.')
        if not staged.is_file() or staged.stat().st_size > 10 * 1024 * 1024:
            raise ValueError('Aboard document is missing or exceeds the 10 MB reading limit.')
        digest = 'sha256:' + hashlib.sha256(staged.read_bytes()).hexdigest()
        if digest != result.get('digest'):
            raise RuntimeError('Aboard file digest did not match; cached file was retained.')
        staged.chmod(0o600)
        os.replace(staged, target)
    source = {'kind': 'aboard', 'server': canonical_server, 'board': board, 'file': name,
              'version': version, 'pinned': pinned is not None, 'digest': digest,
              'fetchedAt': datetime.now(timezone.utc).isoformat()}
    return str(target), source


def refresh_document(path, source, runtime, runner=call_aboard):
    """Refresh a saved source while retaining pins and refusing paths outside its cache identity."""
    from urllib.parse import quote
    suffix = '@v' + str(source['version']) if source.get('pinned') else ''
    uri = 'aboard://' + source['board'] + '/' + quote(source['file'], safe='/') + suffix
    board, name, pinned = parse_uri(uri)
    identity = json.dumps([source['server'], board, name, pinned], separators=(',', ':'))
    expected = Path(runtime).resolve() / 'aboard' / hashlib.sha256(identity.encode()).hexdigest() / Path(name).name
    if Path(path) != expected:
        raise ValueError('Source path does not match the Leaf cache; no file was replaced.')
    return fetch_document(uri, runtime, source['server'], runner)
