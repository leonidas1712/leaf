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

TEXT_EXTENSIONS = {'.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.log', '.tex', '.bib'}
# Documents a tab can show: text, plus PDFs and Word documents, which are read-only. Word
# documents take comments on their rendered text; PDFs take none.
DOCUMENT_EXTENSIONS = TEXT_EXTENSIONS | {'.pdf', '.docx'}
COMMENT_EXTENSIONS = TEXT_EXTENSIONS | {'.docx'}
# Where a split places its target document: the layout, and the target's pane index.
SPLIT_SIDES = {'left': ('columns', 0), 'right': ('columns', 1), 'up': ('rows', 0), 'down': ('rows', 1)}


def empty_workspace():
    """Return the initial versioned workspace with empty document and discussion lists."""
    return {'version': 1, 'revision': 0, 'folders': [], 'files': [], 'tabs': [], 'active': None,
            'recentFiles': [], 'recentFolders': [], 'theme': 'light', 'source': False,
            'search': '', 'sidebarWidth': 280, 'expanded': [], 'groups': [], 'sources': {}, 'collections': [], 'comments': [],
            'editing': {}, 'reader': {'fontSize': 16, 'width': 'normal', 'font': 'sans'}, 'split': None, 'pins': []}


def is_pdf(path):
    """PDFs are read-only documents; a split keeps one beside the source it was built from."""
    return isinstance(path, str) and path.lower().endswith('.pdf')


def normalize_split(split, tabs, active):
    """Keep two distinct open documents side by side, the focused pane always showing the active tab.

    Focusing the other pane's document moves focus there; focusing any other tab replaces the
    focused pane's document, except that a PDF beside a text document stays put: a text tab then
    replaces the text pane, so a compiled paper stays open beside the source being read.
    Closing either pane's document ends the split.
    """
    if not isinstance(split, dict) or active is None:
        return None
    panes = split.get('panes')
    if not isinstance(panes, list) or len(panes) != 2:
        return None
    panes = list(panes)
    focus = split.get('focus') if split.get('focus') in (0, 1) else 0
    if active == panes[1 - focus] or (is_pdf(panes[focus]) and not is_pdf(active) and not is_pdf(panes[1 - focus])):
        focus = 1 - focus
    panes[focus] = active
    if panes[0] == panes[1] or any(pane not in tabs for pane in panes):
        return None
    ratio = split.get('ratio', .5)
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not math.isfinite(ratio):
        ratio = .5
    return {'panes': panes, 'focus': focus, 'layout': 'rows' if split.get('layout') == 'rows' else 'columns',
            'ratio': max(.2, min(.8, float(ratio)))}


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
    result['split'] = normalize_split(view.get('split'), [tab['path'] for tab in result['tabs']], active)
    return result


def remember_recent(data, path):
    """Put a shown document first in the recent list; entries whose files are gone drop out."""
    data['recentFiles'] = [path] + [p for p in data['recentFiles'] if p != path and os.path.exists(p)][:29]


def open_document(data, path, command):
    """Open a supported text document as a tab and record its group, provenance, and collection."""
    resolved = Path(path).expanduser().resolve(strict=True)
    path = str(resolved)
    if not resolved.is_file() or resolved.suffix.lower() not in DOCUMENT_EXTENSIONS:
        raise ValueError('Choose a supported document.')
    if path not in data['files']:
        data['files'].append(path)
    if path not in [tab['path'] for tab in data['tabs']]:
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
    remember_recent(data, path)
    return path


def pin_document(data, path, index=None):
    """Pin a supported text document, or move an existing pin, without opening it."""
    resolved = Path(path).expanduser().resolve(strict=True)
    path = str(resolved)
    if not resolved.is_file() or resolved.suffix.lower() not in DOCUMENT_EXTENSIONS:
        raise ValueError('Pin a supported document.')
    pins = [p for p in data['pins'] if p != path]
    if index is None:
        index = len(pins) if path not in data['pins'] else data['pins'].index(path)
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= len(pins):
        raise ValueError('Pin index is outside the pinned range.')
    pins.insert(index, path)
    data['pins'] = pins
    return path


def keep_in_view(previous, data, editing, command):
    """Keep the document the user is editing on screen when an agent shows a different one.

    The agent's document goes into the other pane, splitting the reader if needed, and focus
    stays with the user. Their pane keeps its place in an existing split.
    """
    keep, shown = previous['active'], data['active']
    if keep not in editing or shown in (None, keep) or keep not in [tab['path'] for tab in data['tabs']]:
        return
    if command['action'] == 'unsplit':
        data['active'], data['split'] = keep, None
        return
    before, after = previous['split'], data['split']
    if before and keep in before['panes']:
        index, base = before['panes'].index(keep), after or before
    elif after:
        index, base = 1 - after['focus'], after
    else:
        index, base = 0, {'layout': 'columns', 'ratio': .5}
    panes = [shown, shown]
    panes[index] = keep
    data['split'] = {'panes': panes, 'focus': index, 'layout': base['layout'], 'ratio': base['ratio']}
    data['active'] = keep


def split_ratio(value):
    """Accept the first pane's share of the split, as a fraction from 0.2 to 0.8."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not .2 <= value <= .8:
        raise ValueError('Split ratio must be 0.2–0.8.')
    return float(value)


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
            self.data['recentFiles'] = [p for p in self.data['recentFiles'] if isinstance(p, str) and os.path.exists(p)]
            pins = self.data['pins'] if isinstance(self.data['pins'], list) else []
            self.data['pins'] = list(dict.fromkeys(p for p in pins if isinstance(p, str) and p.startswith('/')))

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
            data.update(normalize_view({'split': data['split'], **view, 'collections': data['collections']}))
        for tab in data['tabs']:
            tab['group'] = canonical_groups.get(tab['path'])
        group_tabs(data)
        if data['active'] and data['active'] != self.data['active']:
            path = data['active']
            remember_recent(data, path)
        self.commit(data)
        return True

    def action(self, command, editing=()):
        """Apply a command even when no browser is connected, retaining tabs across folders.

        `editing` lists documents open in a reader's editor. Agent commands never move those off
        screen unless they ask to replace the user's view.
        """
        data = copy.deepcopy(self.data)
        action = command['action']
        path = command.get('path')
        paths = [tab['path'] for tab in data['tabs']]
        if action == 'open-file':
            path = open_document(data, path, command)
            if not command.get('background') or data['active'] is None:
                data['active'] = path
        elif action == 'open-folder':
            resolved = Path(path).expanduser().resolve(strict=True)
            path = str(resolved)
            if not resolved.is_dir():
                raise ValueError('The path is not a folder.')
            if path not in data['folders']:
                data['folders'].append(path)
            if path not in data['expanded']:
                data['expanded'].append(path)
            data['recentFolders'] = [path] + [p for p in data['recentFolders'] if p != path][:29]
        elif action.startswith('comment-'):
            apply_comment_action(data, command, COMMENT_EXTENSIONS)
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
            if data['active'] == path and data['split']:
                # The remaining pane takes over the reader.
                data['active'] = data['split']['panes'][1 - data['split']['focus']]
            elif data['active'] == path:
                data['active'] = data['tabs'][min(index, len(data['tabs'])-1)]['path'] if data['tabs'] else None
        elif action == 'split':
            side = command.get('side', 'right')
            if side not in SPLIT_SIDES:
                raise ValueError('Split side must be left, right, up, or down.')
            layout, index = SPLIT_SIDES[side]
            target = path or data['active']
            if not target:
                raise ValueError('Open a document to split.')
            if target not in paths:
                target = open_document(data, target, {})
            beside = command.get('beside')
            if beside is not None and (beside not in paths or beside == target):
                raise ValueError('Split beside a different open tab.')
            if beside is None:
                beside = data['active'] if data['active'] != target else next(
                    (p for p in data['recentFiles'] + paths if p in paths and p != target), None)
            if beside is None:
                raise ValueError('Open another document to split beside.')
            ratio = split_ratio(command['ratio']) if 'ratio' in command else (data['split'] or {}).get('ratio', .5)
            panes = [beside, target] if index else [target, beside]
            data['split'] = {'panes': panes, 'focus': index, 'layout': layout, 'ratio': ratio}
            data['active'] = target
        elif action == 'split-resize':
            if not data['split']:
                raise ValueError('The reader is not split.')
            data['split']['ratio'] = split_ratio(command.get('ratio'))
        elif action == 'unsplit':
            if path is not None:
                if not data['split'] or path not in data['split']['panes']:
                    raise ValueError('Name a document shown in the split.')
                data['active'] = path
            data['split'] = None
        elif action == 'pin':
            if not path:
                raise ValueError('Name a document to pin.')
            pin_document(data, path, command.get('index'))
        elif action == 'unpin':
            if path not in data['pins']:
                raise ValueError('Document is not pinned.')
            data['pins'].remove(path)
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
        if command.get('origin') == 'agent' and not command.get('replace'):
            keep_in_view(self.data, data, set(editing), command)
            data.update(normalize_view(data))
        # Every document shown counts as recent, however it was reached; closing a tab only reveals a neighbour.
        if data['active'] and data['active'] != self.data['active'] and action != 'close-tab':
            remember_recent(data, data['active'])
        self.commit(data)
        return copy.deepcopy(self.data)
