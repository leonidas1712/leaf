"""Keep private document snapshots and compare-and-swap writes outside source folders."""
import difflib
import hashlib
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone

LIMIT = 10 * 1024 * 1024


def utc_now():
    """Return a UTC timestamp shared by history and advisory editing presence."""
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def digest(raw):
    """Identify exact bytes without normalizing newlines or encoding."""
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def read_bytes(path):
    """Read bounded UTF-8 from a regular file and reject unstable or linked targets."""
    path = Path(path)
    if path.resolve() != path or not path.is_file():
        raise ValueError('Document is missing, linked, or no longer a regular file.')
    with path.open('rb') as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError('Editing and history are limited to 10 MiB per document.')
    try:
        raw.decode('utf-8')
    except UnicodeError as error:
        raise ValueError('Editing requires a UTF-8 text document.') from error
    return raw


def merge_text(base, mine, theirs):
    """Run a line-based three-way merge without Git; return text and conflict state."""
    if mine == theirs or base == theirs:
        return mine, False
    if base == mine:
        return theirs, False
    with tempfile.TemporaryDirectory(prefix='leaf-merge-') as directory:
        paths = [Path(directory) / name for name in ('mine', 'base', 'theirs')]
        for path, text in zip(paths, (mine, base, theirs)):
            path.write_bytes(text.encode('utf-8'))
        try:
            result = subprocess.run(['diff3', '-m', '-L', 'mine', '-L', 'base', '-L', 'theirs', *map(str, paths)],
                                    capture_output=True, timeout=15)
        except FileNotFoundError as error:
            raise ValueError('Three-way merge requires diff3 (install diffutils on Linux).') from error
        except subprocess.TimeoutExpired as error:
            raise ValueError('Three-way merge timed out; no document was changed.') from error
        if result.returncode not in (0, 1):
            raise ValueError('Three-way merge failed; no document was changed.')
        return result.stdout.decode('utf-8'), result.returncode == 1


class Changed(ValueError):
    """Carry the current disk text when a save uses an outdated content hash."""

    def __init__(self, current):
        """Retain conflict data for an authenticated HTTP 409 response."""
        super().__init__('changed')
        self.current = current


class VersionStore:
    """Own content-addressed blobs, version metadata and durable checkout bases."""

    def __init__(self, directory):
        """Create an owner-private SQLite history database with atomic metadata updates."""
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        database = directory / 'versions.sqlite3'
        fd = os.open(database, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(database, 0o600)
        self.db = sqlite3.connect(database, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, raw BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
                hash TEXT NOT NULL, at TEXT NOT NULL, author TEXT, kind TEXT NOT NULL, note TEXT NOT NULL,
                added INTEGER NOT NULL, removed INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS versions_path ON versions(path, id);
            CREATE TABLE IF NOT EXISTS checkouts(path TEXT NOT NULL, author TEXT NOT NULL,
                base INTEGER NOT NULL, since TEXT NOT NULL, PRIMARY KEY(path, author));
        ''')
        self.db.commit()

    def close(self):
        """Release the SQLite connection when its reader service stops."""
        self.db.close()

    def metadata(self, row):
        """Expose stable version IDs without internal database fields or file contents."""
        if row is None:
            return None
        return {key: ('v' + str(row[key]) if key == 'id' else row[key])
                for key in ('id', 'hash', 'at', 'author', 'kind', 'note', 'added', 'removed')}

    def row(self, path, version=None):
        """Resolve a version only within its own document path."""
        if version is None:
            return self.db.execute('SELECT * FROM versions WHERE path=? ORDER BY id DESC LIMIT 1', (str(path),)).fetchone()
        if not isinstance(version, str) or not version.startswith('v') or not version[1:].isdigit():
            raise ValueError('Version must be an ID such as v12.')
        row = self.db.execute('SELECT * FROM versions WHERE path=? AND id=?', (str(path), int(version[1:]))).fetchone()
        if row is None:
            raise ValueError('Version is unavailable for this document.')
        return row

    def content(self, path, version):
        """Read a snapshot's exact text without consulting the current source file."""
        row = self.row(path, version)
        return self.db.execute('SELECT raw FROM blobs WHERE hash=?', (row['hash'],)).fetchone()['raw'].decode('utf-8')

    def record(self, path, raw, kind='external', author=None, note=''):
        """Store observed bytes before metadata, deduplicating consecutive identical content."""
        previous = self.row(path)
        hash_value = digest(raw)
        if previous and previous['hash'] == hash_value:
            if kind == 'checkin' and previous['kind'] in ('external', 'checkin') and previous['author'] in (None, author):
                with self.db:
                    self.db.execute('UPDATE versions SET author=?,kind=?,note=? WHERE id=?', (author, kind, note, previous['id']))
            return self.metadata(self.row(path))
        old = self.content(path, 'v' + str(previous['id'])) if previous else ''
        added = removed = 0
        for tag, i, j, k, l in difflib.SequenceMatcher(None, old.splitlines(), raw.decode('utf-8').splitlines(), autojunk=True).get_opcodes():
            if tag != 'equal':
                removed += j - i
                added += l - k
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO blobs VALUES (?,?)', (hash_value, raw))
            self.db.execute('INSERT INTO versions(path,hash,at,author,kind,note,added,removed) VALUES (?,?,?,?,?,?,?,?)',
                            (str(path), hash_value, utc_now(), author, kind, note, added, removed))
        self.prune(path)
        return self.metadata(self.row(path))

    def prune(self, path):
        """Keep recent versions, the latest 200, and active checkout bases; reclaim unused blobs."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat().replace('+00:00', 'Z')
        with self.db:
            self.db.execute('''DELETE FROM versions WHERE path=? AND at<?
                AND id NOT IN (SELECT id FROM versions WHERE path=? ORDER BY id DESC LIMIT 200)
                AND id NOT IN (SELECT base FROM checkouts)''', (str(path), cutoff, str(path)))
            self.db.execute('DELETE FROM blobs WHERE hash NOT IN (SELECT hash FROM versions)')

    def observe(self, path, author=None):
        """Capture the current file as an external version if its bytes changed."""
        return self.record(path, read_bytes(path), author=author)

    def current(self, path, author=None):
        """Return an exact current snapshot and text for editor loading or conflicts."""
        raw = read_bytes(path)
        version = self.record(path, raw, author=author)
        return {'hash': digest(raw), 'version': version['id'], 'text': raw.decode('utf-8')}

    def history(self, path, author=None):
        """Observe current bytes and return newest-first metadata without document text."""
        current = self.current(path, author)
        rows = self.db.execute('SELECT * FROM versions WHERE path=? ORDER BY id DESC', (str(path),)).fetchall()
        bases = {row['base'] for row in self.db.execute('SELECT base FROM checkouts WHERE path=?', (str(path),))}
        return {'current': {'hash': current['hash'], 'version': current['version']},
                'versions': [dict(self.metadata(row), base=row['id'] in bases) for row in rows]}

    def checkout(self, path, author):
        """Record a stable base for each author without locking native file tools."""
        existing = self.db.execute('SELECT * FROM checkouts WHERE path=? AND author=?', (str(path), author)).fetchone()
        if existing:
            return {'author': author, 'since': existing['since'], 'base': 'v' + str(existing['base'])}
        version = self.observe(path)
        since = utc_now()
        with self.db:
            self.db.execute('INSERT INTO checkouts VALUES (?,?,?,?)', (str(path), author, int(version['id'][1:]), since))
        return {'author': author, 'since': since, 'base': version['id']}

    def end(self, path, author):
        """Clear only this author's checkout after a successful save or explicit release."""
        with self.db:
            self.db.execute('DELETE FROM checkouts WHERE path=? AND author=?', (str(path), author))

    def base(self, path, author):
        """Return the author's retained checkout base, or none when no checkout exists."""
        row = self.db.execute('SELECT base FROM checkouts WHERE path=? AND author=?', (str(path), author)).fetchone()
        return 'v' + str(row['base']) if row else None

    def others(self, path, base, author):
        """List observed competing versions after the supplied base, excluding this author."""
        row = self.row(path, base)
        rows = self.db.execute('SELECT * FROM versions WHERE path=? AND id>? AND (author IS NULL OR author!=?) ORDER BY id',
                               (str(path), row['id'], author)).fetchall()
        return [self.metadata(item) for item in rows]

    def checkin(self, path, author, note):
        """Sign current bytes and warn conservatively when observed competing edits may be lost."""
        base = self.base(path, author)
        competing = self.others(path, base, author) if base else []
        raw = read_bytes(path)
        lost = []
        competing = [version for version in competing if version['hash'] != digest(raw)]
        for version in competing[-1:]:
            merged, conflicts = merge_text(self.content(path, base), raw.decode('utf-8'), self.content(path, version['id']))
            if conflicts or merged != raw.decode('utf-8'):
                lost.append(version)
        version = self.record(path, raw, 'checkin', author, note)
        if not lost:
            self.end(path, author)
        return {'status': 'overwrote' if lost else 'ok', 'version': version, 'base': base,
                'overwritten': lost, 'theirs': lost[-1]['id'] if lost else None,
                'message': 'Possible lost edits; merge against the listed version before checking in again.' if lost else 'Edit recorded.'}

    def save(self, path, base, text, author='you', note='', kind='save'):
        """Refuse stale hashes, preserve mode and exact UTF-8 bytes, then replace atomically."""
        if not isinstance(base, str) or not isinstance(text, str):
            raise ValueError('Save requires a base hash and text.')
        raw = text.encode('utf-8')
        if len(raw) > LIMIT:
            raise ValueError('Document exceeds the 10 MiB editing limit.')
        current = self.current(path)
        if current['hash'] != base:
            raise Changed(current)
        mode = stat.S_IMODE(Path(path).stat().st_mode)
        fd, temporary = tempfile.mkstemp(prefix='.leaf-save-', dir=Path(path).parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # Native tools do not share Leaf's lock. Recheck as late as possible.
            if digest(read_bytes(path)) != base:
                raise Changed(self.current(path))
            # Preserve proposed bytes before changing disk; a crash can leave an orphan blob, never lost history.
            with self.db:
                self.db.execute('INSERT OR IGNORE INTO blobs VALUES (?,?)', (digest(raw), raw))
            os.replace(temporary, path)
            version = self.record(path, raw, kind, author, note)
            return {'version': version}
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
