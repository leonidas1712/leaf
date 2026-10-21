"""Expose native-editor workflows through Leaf's authenticated document history API."""
import os
import shlex
from pathlib import Path
from urllib.parse import urlencode

COMMANDS = {'checkout', 'checkin', 'history', 'diff', 'merge', 'restore'}


def configure(parser, name):
    """Declare history arguments without requiring a running reader."""
    parser.add_argument('path', metavar='PATH')
    parser.add_argument('--author', default=None, help='Your name; defaults to LEAF_AUTHOR or agent')
    if name in ('checkin', 'restore'):
        parser.add_argument('-m', '--message', default='')
    if name == 'restore':
        parser.add_argument('version')
    if name == 'diff':
        parser.add_argument('left', nargs='?')
        parser.add_argument('right', nargs='?')
    if name == 'merge':
        parser.add_argument('--base')
        parser.add_argument('--theirs', help='Explicit competing version ID')


def run(args, client):
    """Keep native edits on disk and use server CAS for merge and restore writes."""
    client.start()
    path = str(Path(args.path).expanduser().resolve())
    author = args.author or os.environ.get('LEAF_AUTHOR') or 'agent'
    query = '/api/versions?' + urlencode({'path': path})
    if args.action == 'history':
        client.output(client.request(query), args.json)
        return
    data = {'action': 'edit-start' if args.action == 'checkout' else args.action, 'path': path, 'author': author}
    for key in ('left', 'right', 'base', 'theirs', 'version'):
        if getattr(args, key, None):
            data[key] = getattr(args, key)
    if args.action in ('checkin', 'restore'):
        data['note'] = args.message
    if args.action == 'restore':
        data['base'] = client.request(query)['current']['hash']
    result = client.request('/api/action', data, timeout=30)
    result.pop('workspace', None)
    if result.get('status') == 'overwrote':
        result['mergeCommand'] = shlex.join(['leaf', 'merge', path, '--base', result['base'], '--theirs', result['theirs'], '--author', author])
    if args.action == 'checkout':
        result['message'] = 'Advisory checkout recorded; other tools can still edit this file.'
    if args.action == 'diff' and not args.json:
        print(result['diff'], end='')
    else:
        client.output(result, args.json)
    if result.get('status') in ('overwrote', 'conflicts'):
        raise SystemExit(1)
