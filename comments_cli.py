"""Expose document comment threads through the same CLI and API as the reader."""
import argparse
import os
from pathlib import Path
from urllib.parse import urlencode
from comments import list_comments, markdown_comments


def configure(child, name):
    """Add listing filters and explicit discussion subcommands to argparse."""
    if name == 'comments':
        child.add_argument('paths', nargs='*', metavar='PATH', help='Documents, or folders for every document under them')
        child.add_argument('--all', action='store_true', help='Include every document')
        child.add_argument('--status', choices=['open', 'working', 'resolved', 'all'])
        child.add_argument('--format', choices=['md', 'json'], default='md')
        child.add_argument('--word', action='store_true',
                           help='Save a copy of a .docx beside it with these threads as Word comments (open ones; all with --status all)')
        return
    operations = child.add_subparsers(dest='comment_action', required=True)
    for operation in ('add', 'reply', 'working', 'resolve', 'reopen', 'edit', 'rm', 'anchor'):
        item = operations.add_parser(operation)
        item.add_argument('--json', action='store_true', default=argparse.SUPPRESS)
        item.add_argument('--author', default=None, help='Your agent name; defaults to LEAF_AUTHOR or agent')
        item.add_argument('path' if operation == 'add' else 'id')
        if operation in ('add', 'reply', 'edit'):
            item.add_argument('body')
        if operation in ('working', 'resolve', 'reopen'):
            item.add_argument('note', nargs='?', default='')
        if operation in ('edit', 'rm'):
            item.add_argument('--reply', help='Edit or delete a reply by ID')
        if operation in ('add', 'anchor'):
            item.add_argument('--quote')
            item.add_argument('--prefix', default='')
            item.add_argument('--suffix', default='')
            item.add_argument('--heading', default='')


def run(args, client):
    """List without starting a stopped reader, or persist a mutation through the server."""
    if args.action == 'comments':
        paths = [str(Path(path).expanduser().resolve()) for path in args.paths]
        if args.word:
            if len(paths) != 1 or not paths[0].lower().endswith('.docx'):
                raise ValueError('--word takes one .docx path.')
            client.start()
            result = client.request('/api/comments/word', {'path': paths[0], 'resolved': args.status == 'all'})
            client.output(result if args.json else f"Saved {result['placed'] + result['unplaced']} comments into {result['path']}"
                          + (f" ({result['unplaced']} at the start: passage not found)" if result['unplaced'] else ''), args.json)
            return
        statuses = [args.status] if args.status and args.status != 'all' else (None if args.status == 'all' else ['open', 'working'])
        info = client.running()
        if info:
            query = [('path', p) for p in paths] + [('status', s) for s in (statuses or ['all'])]
            if args.all:
                query.append(('all', 'true'))
            threads = client.request('/api/comments?' + urlencode(query))['comments']
        else:
            from workspace import Workspace
            data = Workspace(client.RUNTIME / 'workspace.json').data
            threads = list_comments(data, None if args.all else (paths or [data['active']]), statuses)
        client.output(threads if args.json or args.format == 'json' else markdown_comments(threads), args.json or args.format == 'json')
        return
    operation = args.comment_action
    command = {'action': 'comment-' + {'add': 'add', 'rm': 'delete', 'working': 'status', 'resolve': 'status', 'reopen': 'status'}.get(operation, operation),
               'author': args.author or os.environ.get('LEAF_AUTHOR') or 'agent'}
    for key in ('id', 'body', 'reply'):
        if getattr(args, key, None) is not None:
            command[key] = getattr(args, key)
    if operation == 'add':
        command['path'] = str(Path(args.path).expanduser().resolve())
    if operation in ('add', 'anchor'):
        command['anchor'] = {'quote': args.quote, 'prefix': args.prefix, 'suffix': args.suffix, 'heading': args.heading} if args.quote else None
    if operation in ('working', 'resolve', 'reopen'):
        command.update(status={'working': 'working', 'resolve': 'resolved', 'reopen': 'open'}[operation], note=args.note)
    client.start()
    saved = client.request('/api/action', command)
    result = client.await_display(saved['revision'])
    result['comments'] = saved['workspace']['comments']
    client.output(result, args.json)
