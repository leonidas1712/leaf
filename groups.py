"""Maintain stable project groups and contiguous tab order without touching document files."""
import secrets

COLORS = ('grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange')


def resolve_group(data, reference):
    """Find a group by stable ID or exact unique name; reject unknown references."""
    for group in data['groups']:
        if reference in (group['id'], group['name']):
            return group
    raise ValueError('Unknown group: ' + str(reference))


def group_tabs(data):
    """Keep each group contiguous at its first occurrence, retaining order inside groups."""
    result, seen = [], set()
    for tab in data['tabs']:
        group = tab.get('group')
        if group is None:
            result.append(tab)
        elif group not in seen:
            result.extend(item for item in data['tabs'] if item.get('group') == group)
            seen.add(group)
    data['tabs'] = result


def open_group(data, group):
    """Restore saved tabs without stealing duplicates already open in another group."""
    existing = {tab['path'] for tab in data['tabs']}
    data['tabs'].extend(dict(tab, group=group['id']) for tab in group['saved'] if tab['path'] not in existing)
    group['saved'] = []
    group['closed'] = False
    group['collapsed'] = False
    group_tabs(data)


def assign_tabs(data, reference, paths):
    """Move existing open tabs into a group or ungroup them, preserving tab positions."""
    if not isinstance(paths, list) or not paths or len(set(paths)) != len(paths):
        raise ValueError('Supply one or more unique open tab paths.')
    group = resolve_group(data, reference) if reference is not None else None
    if group and group['closed']:
        open_group(data, group)
    available = {tab['path'] for tab in data['tabs']}
    if not set(paths) <= available:
        raise ValueError('Every assigned tab must be open.')
    for tab in data['tabs']:
        if tab['path'] in paths:
            tab['group'] = group['id'] if group else None
    group_tabs(data)


def apply_group_action(data, command):
    """Apply a validated group mutation to a transaction copy of the workspace."""
    action = command['action']
    if action == 'group-create':
        name = command.get('name', '').strip()
        if not name or len(name) > 120 or any(g['name'] == name or g['id'] == name for g in data['groups']):
            raise ValueError('Group name must be unique and contain 1–120 characters.')
        color = command.get('color', 'blue')
        if color not in COLORS:
            raise ValueError('Unsupported group color.')
        group = {'id': 'g_' + secrets.token_hex(6), 'name': name, 'color': color,
                 'collapsed': False, 'closed': False, 'saved': []}
        data['groups'].append(group)
        if command.get('paths'):
            assign_tabs(data, group['id'], command['paths'])
    elif action == 'group-ungroup':
        assign_tabs(data, None, command.get('paths'))
    else:
        group = resolve_group(data, command.get('group'))
        if action == 'group-update':
            if 'name' in command:
                name = command['name'].strip()
                if not name or len(name) > 120 or any(g['id'] != group['id'] and name in (g['name'], g['id']) for g in data['groups']):
                    raise ValueError('Group name must be unique and contain 1–120 characters.')
                group['name'] = name
            if 'color' in command:
                if command['color'] not in COLORS:
                    raise ValueError('Unsupported group color.')
                group['color'] = command['color']
            if 'collapsed' in command:
                if not isinstance(command['collapsed'], bool):
                    raise ValueError('collapsed must be boolean.')
                group['collapsed'] = command['collapsed']
        elif action == 'group-add':
            assign_tabs(data, group['id'], command.get('paths'))
        elif action == 'group-close':
            if not group['closed']:
                group['saved'] = [dict(tab) for tab in data['tabs'] if tab.get('group') == group['id']]
                data['tabs'] = [tab for tab in data['tabs'] if tab.get('group') != group['id']]
                group['closed'] = True
        elif action == 'group-open':
            open_group(data, group)
            members = [tab for tab in data['tabs'] if tab.get('group') == group['id']]
            if members:
                data['active'] = members[0]['path']
        elif action == 'group-delete':
            data['tabs'] = [tab for tab in data['tabs'] if tab.get('group') != group['id']]
            data['groups'].remove(group)
        else:
            raise ValueError('Unknown group action: ' + action)
    if data['active'] not in [tab['path'] for tab in data['tabs']]:
        data['active'] = data['tabs'][0]['path'] if data['tabs'] else None
