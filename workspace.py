"""Persist one folder-independent Leaf workspace with atomic, revisioned updates."""
import copy
import json
import os
from pathlib import Path
import tempfile
import math
from library import apply_collection_action
from comments import apply_comment_action
from groups import apply_group_action, assign_tabs, group_tabs, resolve_group

TEXT_EXTENSIONS = {'.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.log'}


def empty_workspace():
    """Return the initial versioned workspace with empty document and discussion lists."""
    return {'version': 1, 'revision': 0, 'folders': [], 'files': [], 'tabs': [], 'active': None,
            'recentFiles': [], 'recentFolders': [], 'theme': 'light', 'source': False,
            'search': '', 'sidebarWidth': 280, 'expanded': [], 'groups': [], 'sources': {}, 'collections': [], 'comments': [],
            'reader': {'fontSize': 16, 'width': 'normal', 'font': 'sans'}}


def normalize_view(view):
    """Validate browser-supplied UI state before writing it to disk."""
    result = {}
    for key in ('folders', 'files', 'expanded'):
        values = view.get(key, [])
        if not isinstance(values, list) or any(not isinstance(p, str) or not (p.startswith('/') or (key == 'expanded' and p in {'collection:' + item['id'] for item in view.get('collections', [])})) for p in values):
            raise ValueError(f'{key} must contain absolute paths.')
        result[key] = list(dict.fromkeys(values))
    tabs = view.get('tabs', [])
    if not isinstance(tabs, list):
        raise ValueError('Tabs must be a list.')
    result['tabs'] = []
    for tab in tabs:
        if not isinstance(tab, dict) or not isinstance(tab.get('path'), str) or not tab['path'].startswith('/'):
            raise ValueError('Tab paths must be absolute.')
        if tab['path'] in [item['path'] for item in result['tabs']]:
            raise ValueError('Duplicate tab path.')
        scroll = float(tab.get('scroll', 0))
        if not math.isfinite(scroll):
            raise ValueError('Scroll position must be finite.')
        result['tabs'].append({'path': tab['path'], 'scroll': max(0, min(1e8, scroll)), 'group': tab.get('group')})
    active = view.get('active')
    if active is not None and active not in [tab['path'] for tab in result['tabs']]:
        raise ValueError('Active document must be an open tab.')
    result['active'] = active
    if view.get('theme', 'light') not in ('light', 'dark', 'system'):
        raise ValueError('Theme must be light, dark, or system.')
    result['theme'] = view.get('theme', 'light')
    result['source'] = bool(view.get('source', False))
    result['search'] = str(view.get('search', ''))[:1000]
    result['sidebarWidth'] = max(180, min(600, float(view.get('sidebarWidth', 280))))
    return result


class Workspace:
    """Own canonical state; reject stale browser writes instead of losing newer changes."""

    def __init__(self, path):
        """Load saved state or fail clearly without overwriting a damaged file."""
        self.path = Path(path)
        self.data = empty_workspace()
        if self.path.exists():
            loaded = json.loads(self.path.read_text())
            if loaded.get('version') != 1:
                raise ValueError('Unsupported workspace version. Saved state was not changed.')
            self.data.update(loaded)
            self.data.update(normalize_view(loaded))

    def save(self):
        """Atomically replace the owner-readable state file after flushing its contents."""
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, name = tempfile.mkstemp(prefix='.workspace-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(self.data, stream, indent=2, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def commit(self, data):
        """Commit a changed workspace and keep the previous state if disk writing fails."""
        if data == self.data:
            return False
        previous = self.data
        data['revision'] = previous['revision'] + 1
        self.data = data
        try:
            self.save()
        except Exception:
            self.data = previous
            raise
        return True

    def sync(self, revision, view, view_only=False):
        """Accept a browser update only when based on the current server revision."""
        if revision != self.data['revision']:
            return False
        data = copy.deepcopy(self.data)
        canonical_groups = {tab['path']: tab.get('group') for tab in data['tabs']}
        if view_only:
            merged = copy.deepcopy(data)
            for key in ('expanded', 'search', 'sidebarWidth'):
                if key in view:
                    merged[key] = view[key]
            positions = {tab['path']: tab.get('scroll', 0) for tab in view.get('tabs', [])}
            for tab in merged['tabs']:
                tab['scroll'] = positions.get(tab['path'], tab['scroll'])
            data.update(normalize_view(merged))
        else:
            data.update(normalize_view(dict(view, collections=data['collections'])))
        for tab in data['tabs']:
            tab['group'] = canonical_groups.get(tab['path'])
        group_tabs(data)
        if data['active'] and data['active'] != self.data['active']:
            path = data['active']
            data['recentFiles'] = [path] + [p for p in data['recentFiles'] if p != path][:29]
        self.commit(data)
        return True

    def action(self, command):
        """Apply a command even when no browser is connected, retaining tabs across folders."""
        data = copy.deepcopy(self.data)
        action = command['action']
        path = command.get('path')
        paths = [tab['path'] for tab in data['tabs']]
        if action in ('open-file', 'open-folder'):
            resolved = Path(path).expanduser().resolve(strict=True)
            path = str(resolved)
            if action == 'open-file':
                if not resolved.is_file() or resolved.suffix.lower() not in TEXT_EXTENSIONS:
                    raise ValueError('Choose a supported text document.')
                if path not in data['files']:
                    data['files'].append(path)
                if path not in paths:
                    data['tabs'].append({'path': path, 'scroll': 0, 'group': None})
                if 'group' in command:
                    assign_tabs(data, command['group'], [path])
                if 'source' in command:
                    source = command['source']
                    if not isinstance(source, dict) or source.get('kind') != 'aboard':
                        raise ValueError('Source must be Aboard metadata.')
                    data['sources'][path] = {key: source[key] for key in ('kind', 'server', 'board', 'file', 'version', 'fetchedAt', 'pinned', 'digest') if key in source}
                if command.get('collection'):
                    apply_collection_action(data, {'action': 'collection-add', 'collection': command['collection'], 'paths': [path]})
                data['active'] = path
                recent = 'recentFiles'
            else:
                if not resolved.is_dir():
                    raise ValueError('The path is not a folder.')
                if path not in data['folders']:
                    data['folders'].append(path)
                if path not in data['expanded']:
                    data['expanded'].append(path)
                recent = 'recentFolders'
            data[recent] = [path] + [p for p in data[recent] if p != path][:29]
        elif action.startswith('comment-'):
            apply_comment_action(data, command, TEXT_EXTENSIONS)
        elif action == 'source-update':
            if path not in data['sources'] or not isinstance(command.get('source'), dict):
                raise ValueError('Source must already exist.')
            source = command['source']
            previous = data['sources'][path]
            if any(source.get(key) != previous.get(key) for key in ('kind', 'server', 'board', 'file', 'pinned')):
                raise ValueError('A refresh cannot change source identity.')
            data['sources'][path] = {key: source[key] for key in ('kind', 'server', 'board', 'file', 'version', 'fetchedAt', 'pinned', 'digest') if key in source}
        elif action.startswith('collection-'):
            apply_collection_action(data, command)
            for source_path, source in command.get('sources', {}).items():
                if action not in ('collection-create', 'collection-add') or source_path not in command.get('paths', []) or not isinstance(source, dict) or source.get('kind') != 'aboard':
                    raise ValueError('Collection source metadata must belong to an added Aboard document.')
                data['sources'][source_path] = {key: source[key] for key in ('kind', 'server', 'board', 'file', 'version', 'fetchedAt', 'pinned', 'digest') if key in source}
        elif action.startswith('group-'):
            apply_group_action(data, command)
        elif action == 'reader':
            reader = dict(data['reader'])
            for key in ('fontSize', 'width', 'font'):
                if key in command:
                    reader[key] = command[key]
            if not isinstance(reader['fontSize'], (int, float)) or not math.isfinite(reader['fontSize']) or not 12 <= reader['fontSize'] <= 28:
                raise ValueError('Reader fontSize must be 12–28 pixels.')
            if reader['width'] not in ('normal', 'wide', 'full') or reader['font'] not in ('sans', 'serif'):
                raise ValueError('Unsupported reader width or font.')
            data['reader'] = reader
        elif action == 'move-tab':
            if path not in paths:
                raise ValueError('Tab is not open.')
            index = command.get('index')
            if not isinstance(index, int) or not 0 <= index < len(paths):
                raise ValueError('Tab index is outside the open tab range.')
            tab = next(tab for tab in data['tabs'] if tab['path'] == path)
            if 'group' in command:
                assign_tabs(data, command['group'], [path])
            data['tabs'].remove(tab)
            data['tabs'].insert(index, tab)
            group_tabs(data)
        elif action == 'focus-tab':
            if path not in paths:
                raise ValueError('Tab is not open.')
            data['active'] = path
        elif action == 'close-tab':
            path = path or data['active']
            if path not in paths:
                raise ValueError('Tab is not open.')
            index = paths.index(path)
            data['tabs'] = [tab for tab in data['tabs'] if tab['path'] != path]
            if data['active'] == path:
                data['active'] = data['tabs'][min(index, len(data['tabs'])-1)]['path'] if data['tabs'] else None
        elif action == 'reorder-tabs':
            order = command.get('paths')
            if not isinstance(order, list) or len(order) != len(paths) or set(order) != set(paths):
                raise ValueError('Supply every open tab path exactly once.')
            data['tabs'] = [next(tab for tab in data['tabs'] if tab['path'] == p) for p in order]
            grouped = copy.deepcopy(data)
            group_tabs(grouped)
            if grouped['tabs'] != data['tabs']:
                raise ValueError('Keep each group contiguous when reordering tabs.')
        elif action == 'remove-folder':
            if path not in data['folders']:
                raise ValueError('Folder is not in the workspace.')
            data['folders'].remove(path)
        elif action in ('expand-folder', 'collapse-folder'):
            targets = command.get('paths', data['folders'] if path == '*' else [path])
            if action == 'expand-folder':
                data['expanded'] = list(dict.fromkeys(data['expanded'] + targets))
            else:
                data['expanded'] = [p for p in data['expanded'] if p not in targets]
        elif action == 'theme':
            if path not in ('light', 'dark', 'system'):
                raise ValueError('Theme must be light, dark, or system.')
            data['theme'] = path
        elif action == 'view':
            if path not in ('source', 'formatted'):
                raise ValueError('View must be source or formatted.')
            data['source'] = path == 'source'
        elif action == 'search':
            data['search'] = path or ''
        elif action == 'sidebar-width':
            width = float(command['width'])
            if not 180 <= width <= 600:
                raise ValueError('Sidebar width must be 180–600 pixels.')
            data['sidebarWidth'] = width
        elif action == 'scroll':
            for tab in data['tabs']:
                if tab['path'] == data['active']:
                    tab['scroll'] = max(0, float(command['top']) if 'top' in command else tab['scroll'] + float(command['by']))
        elif action == 'refresh':
            data['revision'] += 1
        else:
            raise ValueError('Unknown workspace action: ' + action)
        data.update(normalize_view(data))
        self.commit(data)
        return copy.deepcopy(self.data)
