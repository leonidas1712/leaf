"""Maintain virtual document collections without moving or editing source files."""
from pathlib import Path
import secrets
from groups import COLORS, apply_group_action, assign_tabs, open_group


DOCUMENT_EXTENSIONS = {'.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.log', '.tex', '.bib', '.pdf', '.docx'}


def resolve_collection(data, reference):
    """Resolve a stable ID or a root-relative slash path of sibling-unique names."""
    for collection in data['collections']:
        if collection['id'] == reference:
            return collection
    if not isinstance(reference, str) or not reference:
        raise ValueError('Collection reference is required.')
    parent = None
    found = None
    for name in reference.split('/'):
        matches = [item for item in data['collections'] if item['parent'] == parent and item['name'] == name]
        if len(matches) != 1:
            raise ValueError('Unknown or ambiguous collection: ' + reference)
        found = matches[0]
        parent = found['id']
    return found


def descendants(data, identity):
    """Collect a subtree in display order, guarding against corrupt cyclic state."""
    result = []
    pending = [identity]
    seen = set()
    while pending:
        current = pending.pop(0)
        if current in seen:
            raise ValueError('Collection cycle detected.')
        seen.add(current)
        result.append(current)
        children = [item['id'] for item in data['collections'] if item['parent'] == current]
        pending[0:0] = children
    return result


def validate_name(data, name, parent, identity=None):
    """Reject ambiguous collection names before committing a rename or move."""
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120 or '/' in name or name.strip() in ('.', '..'):
        raise ValueError('Collection names need 1–120 characters and cannot contain slash.')
    name = name.strip()
    if any(item['id'] != identity and item['parent'] == parent and item['name'] == name for item in data['collections']):
        raise ValueError('Collection names must be unique among siblings.')
    return name


def document_paths(paths, must_exist=True):
    """Canonicalize text references; permit missing paths only when removing references."""
    if not isinstance(paths, list) or not paths or any(not isinstance(path, str) for path in paths):
        raise ValueError('Supply one or more document paths.')
    result = []
    for raw in paths:
        path = Path(raw).expanduser().resolve(strict=must_exist)
        if must_exist and (not path.is_file() or path.suffix.lower() not in DOCUMENT_EXTENSIONS):
            raise ValueError('Collections accept supported documents only.')
        if str(path) not in result:
            result.append(str(path))
    return result


def insert_at(items, values, index):
    """Insert unique values at an exact list position after removing existing occurrences."""
    remaining = [item for item in items if item not in values]
    if index is None:
        index = len(remaining)
    if not isinstance(index, int) or not 0 <= index <= len(remaining):
        raise ValueError('Insertion index is outside the destination range.')
    return remaining[:index] + values + remaining[index:]


def collection_color(data, collection):
    """Resolve inherited color for the tab group created from a collection."""
    seen = set()
    while collection:
        if collection['id'] in seen:
            raise ValueError('Collection cycle detected.')
        seen.add(collection['id'])
        if collection.get('color'):
            return collection['color']
        collection = resolve_collection(data, collection['parent']) if collection['parent'] else None
    return 'blue'


def apply_collection_action(data, command):
    """Apply one collection action to an isolated workspace transaction."""
    action = command['action']
    if action == 'collection-create':
        parent = resolve_collection(data, command['parent'])['id'] if command.get('parent') else None
        name = validate_name(data, command.get('name'), parent)
        color = command.get('color')
        if color is not None and color not in COLORS:
            raise ValueError('Unsupported collection color.')
        docs = document_paths(command['paths']) if command.get('paths') else []
        data['collections'].append({'id': 'c_' + secrets.token_hex(6), 'name': name, 'parent': parent, 'color': color, 'docs': docs})
        return
    collection = resolve_collection(data, command.get('collection'))
    identity = collection['id']
    if action == 'collection-update':
        if 'name' in command:
            collection['name'] = validate_name(data, command['name'], collection['parent'], identity)
        if 'color' in command:
            if command['color'] is not None and command['color'] not in COLORS:
                raise ValueError('Unsupported collection color.')
            collection['color'] = command['color']
    elif action == 'collection-move':
        parent = resolve_collection(data, command['parent'])['id'] if command.get('parent') else None
        if parent in descendants(data, identity):
            raise ValueError('A collection cannot move into itself or a descendant.')
        validate_name(data, collection['name'], parent, identity)
        siblings = [item for item in data['collections'] if item['parent'] == parent and item['id'] != identity]
        index = command.get('index', len(siblings))
        if not isinstance(index, int) or not 0 <= index <= len(siblings):
            raise ValueError('Sibling index is outside the destination range.')
        data['collections'].remove(collection)
        collection['parent'] = parent
        if index < len(siblings):
            position = data['collections'].index(siblings[index])
        elif siblings:
            position = data['collections'].index(siblings[-1]) + 1
        else:
            position = len(data['collections'])
        data['collections'].insert(position, collection)
    elif action == 'collection-delete':
        removed = set(descendants(data, identity))
        data['collections'] = [item for item in data['collections'] if item['id'] not in removed]
        data['expanded'] = [key for key in data['expanded'] if key not in {'collection:' + value for value in removed}]
        for group in data['groups']:
            if group.get('collection') in removed:
                group.pop('collection')
    elif action == 'collection-add':
        paths = document_paths(command.get('paths'))
        if 'index' in command:
            collection['docs'] = insert_at(collection['docs'], paths, command['index'])
        else:
            collection['docs'] = list(dict.fromkeys(collection['docs'] + paths))
    elif action == 'collection-remove':
        paths = document_paths(command.get('paths'), must_exist=False)
        collection['docs'] = [path for path in collection['docs'] if path not in paths]
    elif action == 'collection-open':
        if not isinstance(command.get('recursive', True), bool):
            raise ValueError('recursive must be boolean.')
        identities = descendants(data, identity) if command.get('recursive', True) else [identity]
        lookup = {item['id']: item for item in data['collections']}
        paths = list(dict.fromkeys(path for key in identities for path in lookup[key]['docs']))
        group = next((item for item in data['groups'] if item.get('collection') == identity), None)
        if group is None:
            name = collection['name']
            suffix = 2
            while any(name in (item['name'], item['id']) for item in data['groups']):
                name = collection['name'] + ' (' + str(suffix) + ')'
                suffix += 1
            apply_group_action(data, {'action': 'group-create', 'name': name, 'color': collection_color(data, collection)})
            group = data['groups'][-1]
            group['collection'] = identity
        if group['closed']:
            open_group(data, group)
        group['collapsed'] = False
        existing = {tab['path'] for tab in data['tabs']}
        for path in paths:
            if path not in existing:
                data['tabs'].append({'path': path, 'scroll': 0, 'group': None})
        if paths:
            assign_tabs(data, group['id'], paths)
            data['active'] = paths[0]
    else:
        raise ValueError('Unknown collection action: ' + action)
