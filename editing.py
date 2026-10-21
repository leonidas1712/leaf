"""Authorize document history and writes against the canonical Leaf library."""
import copy
import difflib
from pathlib import Path
from versions import VersionStore, merge_text

ACTIONS = {'edit-start', 'edit-end', 'checkin', 'restore', 'merge', 'diff'}


class Editing:
    """Serialize history operations under the server's existing workspace lock."""

    def __init__(self, workspace, grants):
        """Bind one private store to one workspace and its transient read grants."""
        self.workspace = workspace
        self.grants = grants
        self.store = VersionStore(workspace.path.parent / 'history')

    def paths(self):
        """Return explicitly registered documents without rescanning sidebar folders."""
        data = self.workspace.data
        return set(data['files'] + [tab['path'] for tab in data['tabs']] +
                   [path for collection in data['collections'] for path in collection['docs']])

    def path(self, value, write=False):
        """Reject unknown, replaced, unsupported and remote-cache write targets."""
        if not isinstance(value, str) or not value.startswith('/'):
            raise ValueError('An absolute known document path is required.')
        path = Path(value)
        from workspace import TEXT_EXTENSIONS
        if path.suffix.lower() not in TEXT_EXTENSIONS or path.resolve() != path:
            raise ValueError('Choose a known UTF-8 text document without symlink changes.')
        known = value in self.paths()
        for root in self.workspace.data['folders']:
            folder = Path(root)
            if folder.resolve() == folder and path.is_relative_to(folder) and path in self.grants.values():
                known = True
        if not known:
            raise ValueError('Unknown document. Open it in Leaf first.')
        if write and (self.workspace.data['sources'].get(value, {}).get('kind') == 'aboard' or
                      path.is_relative_to(self.workspace.path.parent.resolve())):
            raise ValueError('Leaf state and Aboard cached documents are read-only.')
        return path

    def observe(self):
        """Snapshot registered documents; unavailable files remain recoverable references."""
        for value in self.paths():
            try:
                self.store.observe(self.path(value))
            except (OSError, ValueError):
                continue

    def presence(self):
        """Publish advisory checkout state without allowing browser sync to replace it."""
        rows = self.store.db.execute('SELECT * FROM checkouts ORDER BY since').fetchall()
        editing = {row['path']: {'author': row['author'], 'since': row['since'], 'base': 'v' + str(row['base'])} for row in rows}
        data = copy.deepcopy(self.workspace.data)
        data['editing'] = editing
        self.workspace.commit(data)

    def author(self, data):
        """Validate attribution labels, which are advisory rather than authenticated identities."""
        author = data.get('author', 'you')
        if not isinstance(author, str) or not author.strip() or len(author) > 120:
            raise ValueError('Author must contain 1 to 120 characters.')
        return author.strip()

    def save(self, data, kind='save'):
        """Save text with a caller-provided hash, then release only that author's presence."""
        path = self.path(data.get('path'), write=True)
        author = self.author(data)
        note = data.get('note', '')
        if not isinstance(note, str) or len(note) > 50000:
            raise ValueError('Note must be text of at most 50,000 characters.')
        result = self.store.save(path, data.get('base'), data.get('text'), author, note, kind)
        self.store.end(path, author)
        self.presence()
        return result

    def action(self, data):
        """Apply editing commands with shared authorization and CAS writes."""
        action = data['action']
        path = self.path(data.get('path'), write=action != 'diff')
        author = self.author(data)
        if action == 'edit-start':
            previous = self.workspace.data.get('editing', {}).get(str(path))
            result = {'presence': self.store.checkout(path, author)}
            if previous and previous['author'] != author:
                result['warning'] = previous['author'] + ' also said they are editing this document.'
        elif action == 'edit-end':
            self.store.end(path, author)
            result = {}
        elif action == 'checkin':
            note = data.get('note', '')
            if not isinstance(note, str) or len(note) > 50000:
                raise ValueError('Note must be text of at most 50,000 characters.')
            result = self.store.checkin(path, author, note)
        elif action == 'restore':
            return self.save(dict(data, text=self.store.content(path, data.get('version'))), 'restore')
        elif action == 'diff':
            current = self.store.current(path)
            rows = self.store.history(path)['versions']
            left = data.get('left') or self.store.base(path, author) or rows[min(1, len(rows)-1)]['id']
            right = data.get('right')
            text = self.store.content(path, right) if right else current['text']
            diff = ''.join(difflib.unified_diff(self.store.content(path, left).splitlines(keepends=True), text.splitlines(keepends=True), fromfile=left, tofile=right or 'disk'))
            return {'diff': diff, 'base': left, 'current': current['version']}
        elif action == 'merge':
            base = data.get('base') or self.store.base(path, author)
            if not base:
                raise ValueError('Merge requires --base or an active checkout.')
            current = self.store.current(path)
            others = self.store.others(path, base, author)
            theirs = data.get('theirs') or next((v['id'] for v in reversed(others) if v['hash'] != current['hash']), None)
            if not theirs:
                raise ValueError('No competing version found; specify --theirs vN.')
            merged, conflicts = merge_text(self.store.content(path, base), current['text'], self.store.content(path, theirs))
            result = self.store.save(path, current['hash'], merged, author, 'Merge ' + theirs, 'checkin')
            result.update(status='conflicts' if conflicts else 'merged', conflicts=conflicts, theirs=theirs)
            # The explicit merge acknowledges earlier competing versions, even when manual resolution remains.
            self.store.end(path, author)
            self.store.checkout(path, author)
        else:
            raise ValueError('Unknown editing action.')
        self.presence()
        return result
