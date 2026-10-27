"""Expose live LaTeX builds and PDF positions through the CLI: `leaf tex ...`."""
import argparse
import os
from pathlib import Path
from urllib.parse import urlencode

OPERATIONS = {
    'enable': 'Register a LaTeX project (folder, main file, or any file it inputs) and build it',
    'disable': 'Stop building a project; its files and the preview stay',
    'status': 'Show build state, errors, and warnings',
    'build': 'Recompile now and wait for the result (exit 1 when the build fails)',
    'auto': 'Turn automatic recompiling on or off',
    'preview': "Show the live PDF beside the active document",
    'path': 'Print the compiled PDF path (open, copy, or attach it from there)',
    'where': 'Find where FILE[:LINE] appears in the live PDF',
    'page': 'List the source files and lines that make up a PDF page',
}


def configure(child):
    """Add the tex subcommands; PATH defaults to the current directory everywhere."""
    operations = child.add_subparsers(dest='tex_action', required=True, metavar='OPERATION')
    for name, description in OPERATIONS.items():
        item = operations.add_parser(name, help=description, description=description)
        item.add_argument('--json', action='store_true', default=argparse.SUPPRESS, help='Print machine-readable results')
        if name == 'auto':
            item.add_argument('state', choices=['on', 'off'])
        if name == 'where':
            item.add_argument('target', metavar='FILE[:LINE]')
        elif name == 'page':
            item.add_argument('page', type=int)
            item.add_argument('path', nargs='?', default=None, metavar='PATH')
        else:
            item.add_argument('path', nargs='?', default=None, metavar='PATH', help='Project folder or a file in it (default: current folder)')
        if name == 'enable':
            item.add_argument('--main', help='Main .tex file, when it cannot be found automatically')
            item.add_argument('--engine', choices=['latexmk', 'tectonic'], help='Default: latexmk when installed, else tectonic')
            item.add_argument('--bin', help='Folder containing the TeX programs (default: found automatically)')
            item.add_argument('--no-auto', action='store_true', help='Start with automatic recompiling off')
            item.add_argument('--preview', action='store_true', help='Also show the live PDF beside the active document')
        if name in ('enable', 'build'):
            item.add_argument('--no-wait', action='store_true', help='Return without waiting for the build')
            item.add_argument('--timeout', type=float, default=300, help='Seconds to wait for the build (default 300)')


def target(path):
    return str(Path(path or os.getcwd()).expanduser().resolve())


def relative(path, root):
    if not path:
        return '(no file)'
    try:
        return str(Path(path).relative_to(root))
    except ValueError:
        return path


def summary(project):
    """A short, readable status: state, the last build, and every error with its file and line."""
    root = project['root']
    build = project.get('lastBuild')
    lines = [f"{Path(root).name}: {project['state']}  (auto-compile {'on' if project['auto'] else 'off'}, {project['engine']})",
             f"main: {project['main']}", f"compiled PDF: {project['pdf']}" + ('' if project['pdfExists'] else ' (not built yet)')]
    if project.get('changedFiles'):
        lines.append('changed since the last build: ' + ', '.join(relative(p, root) for p in project['changedFiles']))
    if build:
        lines.append(f"last build: {'succeeded' if build['ok'] else 'failed'} in {build['seconds']}s, "
                     f"{build['errorCount']} errors, {build['warningCount']} warnings, {build['boxCount']} bad boxes")
        for kind in ('errors', 'warnings'):
            if build[kind]:
                lines.append(kind + ':')
                for item in build[kind][:20 if kind == 'errors' else 10]:
                    where = relative(item['path'], root) + (f":{item['line']}" if item.get('line') else '')
                    lines.append(f'  {where}  {item["message"]}')
        if build.get('log'):
            lines.append(f"log: {build['log']}")
    return '\n'.join(lines)


def show_preview(client, project):
    """Split the live PDF beside the active document; when it is already shown, leave the layout alone."""
    workspace = client.request('/api/status')['workspace']
    split = workspace.get('split') or {}
    if project['pdf'] in split.get('panes', []):
        return {'status': 'unchanged', 'active': workspace['active'], 'split': split}
    command = {'action': 'split', 'path': project['pdf'], 'side': 'right', 'origin': 'agent'}
    if workspace.get('active') and workspace['active'] != project['pdf']:
        command['beside'] = workspace['active']
    saved = client.request('/api/action', command, timeout=30)
    result = client.await_display(saved['revision'])
    result.update(active=saved['workspace']['active'], split=saved['workspace']['split'])
    return result


def run(args, client):
    """Read status without starting Leaf; everything else goes through the running service."""
    operation = args.tex_action
    as_json = getattr(args, 'json', False)
    if operation == 'path':
        info = client.running()
        if info:
            projects = client.request('/api/tex')['projects']
        else:
            from tex import TexProjects
            projects = TexProjects(client.RUNTIME).statuses()
        wanted = Path(target(args.path))
        project = next((p for p in projects if wanted == Path(p['root']) or Path(p['root']) in wanted.parents), None)
        if project is None:
            raise ValueError('No live LaTeX project here. Run: leaf tex enable PATH')
        if as_json:
            client.output({'pdf': project['pdf'], 'exists': project['pdfExists'], 'synctex': project['synctex'], 'root': project['root']}, True)
        else:
            print(project['pdf'])
        if not project['pdfExists']:
            raise SystemExit(1)
        return
    if operation == 'status':
        if client.running():
            projects = client.request('/api/tex')['projects']
        else:
            from tex import TexProjects
            projects = TexProjects(client.RUNTIME).statuses()
        if args.path:
            wanted = Path(target(args.path))
            projects = [p for p in projects if wanted == Path(p['root']) or Path(p['root']) in wanted.parents or wanted == Path(p['pdf'])]
        if as_json:
            client.output(projects, True)
        else:
            print('\n\n'.join(summary(p) for p in projects) or 'No live LaTeX projects. Enable one with: leaf tex enable PATH')
        return
    client.start()
    if operation in ('where', 'page'):
        if operation == 'where':
            file, _, line = args.target.rpartition(':') if args.target.rpartition(':')[2].isdigit() else (args.target, '', '')
            query = {'path': target(file)}
            if line:
                query['line'] = line
            result = client.request('/api/tex/forward?' + urlencode(query))
        else:
            result = client.request('/api/tex/page?' + urlencode({'path': target(args.path), 'page': args.page}))
        if as_json:
            client.output(result, True)
        elif operation == 'where':
            print(f"{result['path']}:{result['line']} is on page {result['page']}, {round(result['y'])}pt from the top.")
        else:
            print(f"Page {result['page']} is typeset from:")
            for source in result['sources']:
                lines = f"line {source['from']}" if source['from'] == source['to'] else f"lines {source['from']}–{source['to']}"
                print(f"  {source['path']}  {lines}")
        return
    if operation == 'preview':
        projects = [p for p in client.request('/api/tex')['projects']]
        wanted = Path(target(args.path))
        project = next((p for p in projects if wanted == Path(p['root']) or Path(p['root']) in wanted.parents), None)
        if project is None:
            raise ValueError('No live LaTeX project here. Run: leaf tex enable PATH')
        if not project['pdfExists']:
            raise ValueError('The project has not built yet. Run: leaf tex build PATH')
        client.output(show_preview(client, project), as_json)
        return
    command = {'action': operation, 'path': target(args.path)}
    if operation == 'auto':
        command['auto'] = args.state == 'on'
    if operation == 'enable':
        command.update({key: getattr(args, key) for key in ('main', 'engine', 'bin') if getattr(args, key)})
        if args.main:
            command['main'] = str(Path(args.main).expanduser().resolve())
        if args.no_auto:
            command['auto'] = False
    if operation in ('enable', 'build') and not args.no_wait:
        command['wait'] = max(1, min(600, args.timeout))
    result = client.request('/api/tex', command, timeout=command.get('wait', 0) + 30)
    project = result.get('project')
    if operation == 'enable' and args.preview and project and project['pdfExists']:
        result['display'] = show_preview(client, project)
    if as_json:
        client.output(result, True)
    else:
        print(summary(project) if project else f"Disabled live LaTeX builds for {result['root']}.")
        if operation in ('enable', 'build') and command.get('wait') and not result.get('finished'):
            print('The build is still running. Check again with: leaf tex status')
    if operation in ('enable', 'build') and result.get('finished') and project and project['lastBuild'] and not project['lastBuild']['ok']:
        raise SystemExit(1)
