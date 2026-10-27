"""Build registered LaTeX projects into Leaf's state directory and map source lines to PDF positions.

A project is registered once (`leaf tex enable`), because building runs the project's own code.
Output goes to the state directory, never the project: the project's own main.pdf and aux files
stay untouched. Builds run one at a time on a worker thread. While auto-compile is on, changes are
batched: a build starts once the sources have been quiet for a moment, edits made during a build
collapse into one follow-up build, and a failed build whose sources changed mid-build is discarded
rather than reported, since it compiled a half-edited tree.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time

QUIET = 1.2          # Seconds without source changes before an automatic build starts.
TIMEOUT = 300        # Seconds before a build is stopped.
SP_PER_BP = 65781.76  # TeX scaled points per PDF big point.
ENGINES = ('latexmk', 'tectonic')
SOURCE_SUFFIXES = {'.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.def', '.cfg', '.ltx'}
SKIP_DIRS = {'node_modules', 'vendor', 'venv', '__pycache__', 'dist', 'build', 'out', '_build'}


def has_documentclass(path):
    """A main file declares its class near the top; inputs never do."""
    try:
        with open(path, encoding='utf-8', errors='replace') as stream:
            head = stream.read(20000)
    except OSError:
        return False
    return re.search(r'^[^%\n]*\\documentclass', head, re.M) is not None


def magic_root(path):
    """Honour a `% !TEX root = ../main.tex` comment in the first lines of a file."""
    try:
        with open(path, encoding='utf-8', errors='replace') as stream:
            for _ in range(20):
                match = re.match(r'\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$', stream.readline(), re.I)
                if match:
                    target = (path.parent / match.group(1)).resolve()
                    return target if target.is_file() else None
    except OSError:
        pass
    return None


def main_in(directory):
    """`main.tex` when it is a main file, else the one top-level file with a document class."""
    preferred = directory / 'main.tex'
    if preferred.is_file() and has_documentclass(preferred):
        return preferred
    candidates = sorted(p for p in directory.glob('*.tex') if p.is_file() and has_documentclass(p))
    if len(candidates) > 1:
        names = ', '.join(p.name for p in candidates)
        raise ValueError(f'Several main files in {directory} ({names}). Choose one with --main.')
    return candidates[0] if candidates else None


def find_main(path, main=None):
    """Resolve the main file for a folder, a main file, or any file a main file inputs."""
    path = Path(path).expanduser().resolve(strict=True)
    if main:
        candidate = Path(main).expanduser()
        candidate = (candidate if candidate.is_absolute() else (path if path.is_dir() else path.parent) / candidate).resolve(strict=True)
        if candidate.suffix.lower() != '.tex' or not has_documentclass(candidate):
            raise ValueError(f'{candidate} has no \\documentclass; choose the main .tex file.')
        return candidate
    if path.is_file():
        if path.suffix.lower() != '.tex':
            raise ValueError('Choose a LaTeX folder or .tex file.')
        if has_documentclass(path):
            return path
        target = magic_root(path)
        if target:
            return target
        directory = path.parent
    else:
        directory = path
    home = Path.home()
    for _ in range(6):
        found = main_in(directory)
        if found:
            return found
        if directory in (home, directory.parent) or (directory / '.git').exists():
            break
        directory = directory.parent
    raise ValueError(f'No main .tex file (one with \\documentclass) found for {path}. Pass --main.')


def tex_bin_candidates(root):
    """Places TeX distributions commonly live, project-local first, before PATH."""
    patterns = [root / '.tools/TinyTeX/bin', Path.home() / 'Library/TinyTeX/bin', Path.home() / '.TinyTeX/bin']
    found = [child for base in patterns if base.is_dir() for child in sorted(base.iterdir()) if child.is_dir()]
    found += [Path('/Library/TeX/texbin')]
    found += sorted(Path('/usr/local/texlive').glob('*/bin/*'), reverse=True)
    return [str(p) for p in found if p.is_dir()]


def which(name, bin_dir=None):
    path = os.pathsep.join(([bin_dir] if bin_dir else []) + [os.environ.get('PATH', '')])
    return shutil.which(name, path=path)


def detect_toolchain(root, engine=None, bin_dir=None):
    """Prefer latexmk (it honours the project's latexmkrc), then tectonic; report what was chosen."""
    if engine and engine not in ENGINES:
        raise ValueError('Engine must be latexmk or tectonic.')
    if bin_dir:
        bin_dir = str(Path(bin_dir).expanduser().resolve(strict=True))
    for name in ([engine] if engine else list(ENGINES)):
        for candidate in ([bin_dir] if bin_dir else tex_bin_candidates(root) + [None]):
            if which(name, candidate) and (name != 'latexmk' or which('pdflatex', candidate) or which('xelatex', candidate) or which('lualatex', candidate)):
                return name, candidate
    wanted = engine or 'latexmk (TeX Live, MacTeX, or TinyTeX) or tectonic'
    raise ValueError(f'No {wanted} found. Install one, or pass --bin with the folder that holds it.')


def project_slug(root):
    name = re.sub(r'[^A-Za-z0-9._-]+', '-', root.name).strip('-') or 'paper'
    return f'{name}-{hashlib.sha1(str(root).encode()).hexdigest()[:8]}'


# ---------------------------------------------------------------------------- Log parsing

FILE_LINE = re.compile(r'^(\S.*?\.(?:tex|sty|cls|ltx|bib|bbl|def|cfg|clo|fd|aux)):(\d+): (.*)$')
WARNING = re.compile(r'^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$')
BOX = re.compile(r'^((?:Over|Under)full \\[hv]box .*?)(?: in paragraph| in alignment| detected| has occurred while \\output is active)?(?: at lines? (\d+)(?:--\d+)?)?$')
OPEN_FILE = re.compile(r'\(("?)([^\s()"]+\.[A-Za-z0-9]{1,8})\1')


def parse_log(text, root):
    """Errors, warnings, and bad boxes, each with the source file and line when TeX names them.

    Files are tracked the way TeX logs them: "(path" opens a file and ")" closes the innermost one.
    """
    errors, warnings, boxes = [], [], []
    stack = []
    lines = text.splitlines()

    def where(name):
        if not name:
            return None
        candidate = Path(name)
        candidate = (candidate if candidate.is_absolute() else root / candidate).resolve()
        return str(candidate)

    def current():
        return next((name for name in reversed(stack) if name), None)

    for index, line in enumerate(lines):
        match = FILE_LINE.match(line)
        if match:
            errors.append({'path': where(match.group(1)), 'line': int(match.group(2)), 'message': match.group(3).strip()[:400]})
        elif line.startswith('! '):
            number = None
            for following in lines[index + 1:index + 14]:
                found = re.match(r'^l\.(\d+)', following)
                if found:
                    number = int(found.group(1))
                    break
            errors.append({'path': where(current()), 'line': number, 'message': line[2:].strip()[:400]})
        else:
            warning = WARNING.match(line)
            box = BOX.match(line) if 'full \\' in line else None
            if warning:
                message = warning.group(3).strip()
                follow = index + 1
                # Package warnings continue on lines indented under "(package)".
                while follow < len(lines) and re.match(r'^\(\S+\)\s', lines[follow]) and follow - index < 6:
                    message += ' ' + re.sub(r'^\(\S+\)\s+', '', lines[follow]).strip()
                    follow += 1
                number = re.search(r'on input line (\d+)', message)
                source = warning.group(1) or warning.group(2)
                warnings.append({'path': where(current()), 'line': int(number.group(1)) if number else None,
                                 'message': ((source + ': ') if source else '') + message[:400]})
            elif box:
                boxes.append({'path': where(current()), 'line': int(box.group(2)) if box.group(2) else None, 'message': box.group(1)[:200]})
        position = 0
        while position < len(line):
            char = line[position]
            if char == '(':
                opened = OPEN_FILE.match(line, position)
                if opened:
                    stack.append(opened.group(2))
                    position = opened.end()
                    continue
                stack.append(None)
            elif char == ')' and stack:
                stack.pop()
            position += 1
    unique = []
    for error in errors:
        if error not in unique:
            unique.append(error)
    return unique, warnings, boxes


# ---------------------------------------------------------------------------- SyncTeX

RECORD = re.compile(r'^([\[(vhxkg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?')


class SyncIndex:
    """Positions of every source line in the PDF, read from a .synctex.gz file.

    Coordinates are PDF points from the page's top-left corner. Only project files are kept.
    """

    def __init__(self, path, root):
        inputs = {}
        unit, x_offset, y_offset = 1.0, 0.0, 0.0
        self.pages = {}
        self.by_file = {}
        page = 0
        prefix = str(root) + os.sep
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as stream:
            for raw in stream:
                head = raw[:1]
                if head in '[(vhxkg$' and page:
                    match = RECORD.match(raw)
                    if not match:
                        continue
                    name = inputs.get(int(match.group(2)))
                    if not name:
                        continue
                    kind = match.group(1)
                    scale = unit / SP_PER_BP
                    h = int(match.group(4)) * scale + x_offset
                    v = int(match.group(5)) * scale + y_offset
                    width = abs(int(match.group(6) or 0)) * scale if kind in '[(vh' else 0.0
                    height = int(match.group(7) or 0) * scale
                    depth = int(match.group(8) or 0) * scale
                    record = (page, name, int(match.group(3)), kind, h, v - height, width, height + depth)
                    self.pages.setdefault(page, []).append(record)
                    self.by_file.setdefault(name, []).append(record)
                elif head == '{':
                    page = int(raw[1:].strip() or 0)
                elif head == '}':
                    page = 0
                elif raw.startswith('Input:'):
                    number, _, name = raw[6:].rstrip('\n').partition(':')
                    resolved = os.path.normpath(name)
                    # Project files only; TeX distributions installed inside the project are hidden folders.
                    if resolved.startswith(prefix) and not any(part.startswith('.') for part in Path(resolved[len(prefix):]).parts):
                        inputs[int(number)] = resolved
                elif raw.startswith('Unit:'):
                    unit = float(raw[5:])
                elif raw.startswith('X Offset:'):
                    x_offset = int(raw[9:]) / SP_PER_BP
                elif raw.startswith('Y Offset:'):
                    y_offset = int(raw[9:]) / SP_PER_BP

    def forward(self, path, line=None):
        """Where a source line appears: the page and the box around its typeset lines.

        Without a line, the start of the file. A line that produced no output maps to the nearest one.
        """
        records = self.by_file.get(str(path))
        if not records:
            return None
        lines = {record[2] for record in records}
        target = min(lines) if line is None else min(lines, key=lambda value: (abs(value - line), value < line))
        chosen = [record for record in records if record[2] == target]
        boxes = [record for record in chosen if record[3] == '(' and record[6] > 0] or [record for record in chosen if record[6] > 0] or chosen
        first = min(boxes, key=lambda record: (record[0], record[5]))
        same = [record for record in boxes if record[0] == first[0] and abs(record[5] - first[5]) < 400]
        left = min(record[4] for record in same)
        top = min(record[5] for record in same)
        right = max(record[4] + record[6] for record in same)
        bottom = max(record[5] + record[7] for record in same)
        return {'page': first[0], 'x': round(left, 2), 'y': round(top, 2), 'width': round(right - left, 2),
                'height': round(max(bottom - top, 8), 2), 'path': str(path), 'line': target}

    def inverse(self, page, x, y):
        """The source line behind a point on a page: the smallest line box holding it, else the nearest."""
        records = self.pages.get(page)
        if not records:
            return None
        holding = [record for record in records if record[3] in '(h' and record[6] > 0
                   and record[4] - 1 <= x <= record[4] + record[6] + 1 and record[5] - 1 <= y <= record[5] + record[7] + 1]
        if holding:
            best = min(holding, key=lambda record: record[6] * max(record[7], 1))
        else:
            def distance(record):
                dx = max(record[4] - x, 0, x - (record[4] + record[6]))
                dy = max(record[5] - y, 0, y - (record[5] + record[7]))
                return dx * dx + dy * dy * 4
            best = min(records, key=distance)
        return {'path': best[1], 'line': best[2], 'page': page}

    def page_sources(self, page):
        """Which source files, and which of their lines, typeset a page, in the order they appear."""
        spans = {}
        for record in self.pages.get(page, []):
            low, high = spans.get(record[1], (record[2], record[2]))
            spans[record[1]] = (min(low, record[2]), max(high, record[2]))
        return [{'path': path, 'from': low, 'to': high} for path, (low, high) in spans.items()]


# ---------------------------------------------------------------------------- Projects

class Project:
    """One registered main file, its settings, and the state of its builds."""

    def __init__(self, config, state_dir):
        self.root = Path(config['root'])
        self.main = config['main']
        self.engine = config['engine']
        self.bin = config.get('bin')
        self.auto = config.get('auto', True)
        self.out = state_dir / 'tex' / project_slug(self.root)
        self.build_dir = self.out / 'build'
        self.pdf = self.out / (self.root.name + '.pdf')
        self.synctex = self.out / (self.root.name + '.synctex.gz')
        self.deps = []
        self.seen = None        # Source signature at the last poll.
        self.built = None       # Source signature when the last finished build started.
        self.changed_at = 0.0
        self.building = False
        self.requested = 0      # Build requests (manual or automatic) handed out.
        self.completed = 0      # Requests satisfied by a finished build.
        self.manual = False
        self.result = None
        self.stats = {}
        self.sync = None
        self.load_saved()

    def config(self):
        return {'root': str(self.root), 'main': self.main, 'engine': self.engine, 'bin': self.bin, 'auto': self.auto}

    def load_saved(self):
        """Show the last build again after a restart, so the preview works before a rebuild."""
        try:
            saved = json.loads((self.out / 'result.json').read_text())
            self.result = saved['result']
            self.deps = saved.get('deps', [])
            self.built = saved.get('signature')
        except (OSError, ValueError, KeyError):
            pass

    def save_result(self, signature):
        temporary = self.out / 'result.json.tmp'
        temporary.write_text(json.dumps({'result': self.result, 'deps': self.deps, 'signature': signature}))
        os.replace(temporary, self.out / 'result.json')

    def sources(self):
        """The files the last build read, or a scan of the project before there was one."""
        if self.deps:
            return [Path(path) for path in self.deps]
        found = []
        for directory, dirs, names in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP_DIRS)
            found += [Path(directory) / name for name in sorted(names) if Path(name).suffix.lower() in SOURCE_SUFFIXES]
            if len(found) > 3000:
                break
        return found

    def signature(self, paths=None):
        stamps = {}
        for path in (self.sources() if paths is None else paths):
            try:
                stat = path.stat()
                stamps[str(path)] = [stat.st_mtime_ns, stat.st_size]
            except OSError:
                stamps[str(path)] = None
        return stamps

    def read_deps(self):
        """Source files latexmk recorded (generated files carry a generator name and are skipped)."""
        deps = set()
        record = self.build_dir / (Path(self.main).stem + '.fdb_latexmk')
        try:
            text = record.read_text(errors='replace')
        except OSError:
            return []
        for match in re.finditer(r'^\s+"(.+?)"\s+\S+\s+\S+\s+\S+\s+"(.*?)"\s*$', text, re.M):
            if match.group(2):
                continue
            path = Path(match.group(1))
            path = (path if path.is_absolute() else self.root / path).resolve()
            try:
                relative = path.relative_to(self.root)
            except ValueError:
                continue
            if path.is_file() and not any(part.startswith('.') for part in relative.parts):
                deps.add(str(path))
        return sorted(deps)

    def command(self, force=False):
        main = self.main
        if self.engine == 'tectonic':
            return [which('tectonic', self.bin) or 'tectonic', '-X', 'compile', main, '--synctex', '--keep-logs',
                    '--keep-intermediates', '--outdir', str(self.build_dir)]
        command = [which('latexmk', self.bin) or 'latexmk', '-synctex=1', '-interaction=nonstopmode', '-file-line-error',
                   '-outdir=' + str(self.build_dir)]
        # A project's own latexmkrc chooses the engine (pdf, xe, lua); otherwise build a PDF with pdflatex.
        if not any((self.root / name).is_file() for name in ('latexmkrc', '.latexmkrc')):
            command.insert(1, '-pdf')
        # Recompile means recompile, as in Overleaf: latexmk would otherwise skip an up-to-date PDF.
        if force:
            command.insert(1, '-g')
        return command + [main]

    def build(self):
        """Run one build and publish its PDF, SyncTeX, and diagnostics. Returns whether it is final."""
        self.build_dir.mkdir(parents=True, exist_ok=True)
        watched = self.sources()
        before = self.signature(watched)
        started = time.time()
        env = dict(os.environ, max_print_line='1000', error_line='254', half_error_line='238')
        if self.bin:
            env['PATH'] = self.bin + os.pathsep + env.get('PATH', '')
        output, code = '', None
        try:
            process = subprocess.Popen(self.command(force=self.manual), cwd=self.root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                output = process.communicate(timeout=TIMEOUT)[0].decode('utf-8', 'replace')
                code = process.returncode
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                output = process.communicate()[0].decode('utf-8', 'replace') + f'\nStopped after {TIMEOUT} seconds.'
        except OSError as error:
            output = str(error)
        stem = Path(self.main).stem
        built_pdf = self.build_dir / (stem + '.pdf')
        # latexmk exits 0 without rewriting the PDF when nothing changed; that is still a good build.
        ok = code == 0 and built_pdf.is_file()
        log_path = self.build_dir / (stem + '.log')
        try:
            log = log_path.read_text(errors='replace')
        except OSError:
            log = ''
        errors, warnings, boxes = parse_log(log, self.root)
        errors = [error for error in errors if not error['message'].startswith('==> Fatal error')]
        if not ok:
            # A stopped build never resolved references or citations; its warnings are noise until it builds.
            warnings, boxes = [], []
        if not ok and not errors:
            for line in output.splitlines():
                match = re.match(r'^error: (?:(\S+?):(\d+): )?(.*)$', line)
                if match:
                    path = str((self.root / match.group(1)).resolve()) if match.group(1) else None
                    errors.append({'path': path, 'line': int(match.group(2)) if match.group(2) else None, 'message': match.group(3)[:400]})
        if not ok and not errors:
            tail = [line for line in output.strip().splitlines() if line.strip()][-3:]
            errors.append({'path': None, 'line': None, 'message': ' '.join(tail)[:400] or 'The build failed without a message.'})
        deps = self.read_deps()
        if deps:
            self.deps = sorted(set(deps) | (set() if ok else set(self.deps)))
        changed = self.signature(watched) != before
        if not ok and changed and self.auto and not self.manual:
            return False  # A half-edited tree failed: build again once the edits settle.
        if ok:
            shutil.copyfile(built_pdf, self.out / 'preview.tmp')
            os.replace(self.out / 'preview.tmp', self.pdf)
            synctex = self.build_dir / (stem + '.synctex.gz')
            if synctex.is_file():
                shutil.copyfile(synctex, self.out / 'synctex.tmp')
                os.replace(self.out / 'synctex.tmp', self.synctex)
            self.sync = None
        self.result = {
            'ok': ok, 'startedAt': started, 'finishedAt': time.time(), 'seconds': round(time.time() - started, 1),
            'errors': errors[:50], 'errorCount': len(errors), 'warnings': warnings[:100], 'warningCount': len(warnings),
            'boxes': boxes[:30], 'boxCount': len(boxes), 'log': str(log_path) if log else None,
            'changedDuringBuild': changed,
        }
        # Compare later polls against this build's own file list; edits during it stay pending.
        self.built = before if changed else self.signature()
        self.save_result(self.built)
        return True

    def status(self):
        dirty = self.seen is not None and self.seen != self.built
        if self.building:
            state = 'building'
        elif dirty:
            state = 'queued' if self.auto else 'outdated'
        elif self.result is None:
            state = 'idle'
        else:
            state = 'ok' if self.result['ok'] else 'failed'
        changed = []
        if dirty and self.built:
            changed = sorted(path for path, stamp in self.seen.items() if self.built.get(path) != stamp)[:20]
        return {
            'root': str(self.root), 'main': str(self.root / self.main), 'engine': self.engine, 'bin': self.bin,
            'auto': self.auto, 'state': state, 'building': self.building, 'outdated': dirty,
            'changedFiles': changed, 'pdf': str(self.pdf), 'pdfExists': self.pdf.is_file(),
            'synctex': self.synctex.is_file(), 'lastBuild': self.result,
        }

    def index(self):
        if not self.synctex.is_file():
            raise ValueError('No SyncTeX data yet. Build the project first.')
        stamp = self.synctex.stat().st_mtime_ns
        if not self.sync or self.sync[0] != stamp:
            self.sync = (stamp, SyncIndex(self.synctex, self.root))
        return self.sync[1]


class TexProjects:
    """Registered projects, their persisted settings, and the single build worker."""

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)
        self.config_path = self.state_dir / 'tex.json'
        self.lock = threading.Condition()
        self.projects = {}
        try:
            for config in json.loads(self.config_path.read_text()).get('projects', []):
                project = Project(config, self.state_dir)
                self.projects[str(project.root)] = project
        except (OSError, ValueError, KeyError):
            pass
        self.stop = threading.Event()
        self.worker = None

    def start(self):
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def close(self):
        self.stop.set()
        with self.lock:
            self.lock.notify_all()
        if self.worker:
            self.worker.join(timeout=2)

    def save(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.config_path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'projects': [p.config() for p in self.projects.values()]}, indent=2))
        os.replace(temporary, self.config_path)

    def find(self, path):
        """The registered project containing a path, its preview PDF, or its root; the deepest root wins."""
        path = Path(path).expanduser()
        path = path.resolve() if path.exists() else path
        best = None
        for project in self.projects.values():
            if path in (project.pdf, project.synctex) or path == project.root or project.root in path.parents:
                if best is None or len(str(project.root)) > len(str(best.root)):
                    best = project
        return best

    def require(self, path):
        project = self.find(path) if path else (next(iter(self.projects.values())) if len(self.projects) == 1 else None)
        if project is None:
            raise ValueError('No live LaTeX project here. Run: leaf tex enable PATH' if path else 'Name a project path; several or none are enabled.')
        return project

    def enable(self, path, main=None, engine=None, bin_dir=None, auto=None):
        main_file = find_main(path, main)
        root = main_file.parent
        chosen, found_bin = detect_toolchain(root, engine, bin_dir)
        with self.lock:
            existing = self.projects.get(str(root))
            config = {'root': str(root), 'main': main_file.name, 'engine': chosen, 'bin': found_bin,
                      'auto': existing.auto if existing and auto is None else (True if auto is None else auto)}
            if existing and existing.config() == config:
                project = existing
            else:
                project = Project(config, self.state_dir)
                self.projects[str(root)] = project
                self.save()
            project.requested += 1
            project.manual = True
            self.lock.notify_all()
            return project.status(), project.requested

    def disable(self, path):
        with self.lock:
            project = self.require(path)
            del self.projects[str(project.root)]
            self.save()
            return {'root': str(project.root), 'enabled': False}

    def set_auto(self, path, auto):
        with self.lock:
            project = self.require(path)
            project.auto = bool(auto)
            self.save()
            self.lock.notify_all()
            return project.status()

    def request(self, path):
        with self.lock:
            project = self.require(path)
            project.requested += 1
            project.manual = True
            self.lock.notify_all()
            return project, project.requested

    def wait(self, project, ticket, timeout):
        """Block until a build that started after the request has finished."""
        deadline = time.time() + timeout
        with self.lock:
            while project.completed < ticket and time.time() < deadline and not self.stop.is_set():
                self.lock.wait(min(1, deadline - time.time()))
            return project.status(), project.completed >= ticket

    def statuses(self):
        with self.lock:
            return [project.status() for project in self.projects.values()]

    def run(self):
        """Poll sources each second; build what is requested or has settled, one project at a time."""
        while not self.stop.is_set():
            job = None
            with self.lock:
                now = time.time()
                for project in list(self.projects.values()):
                    try:
                        signature = project.signature()
                    except OSError:
                        continue
                    if signature != project.seen:
                        project.seen = signature
                        project.changed_at = now
                    dirty = project.seen != project.built
                    settled = now - project.changed_at >= QUIET
                    if project.requested > project.completed or (project.auto and dirty and settled):
                        job = project
                        break
                if job:
                    job.building = True
                    ticket = job.requested
                else:
                    self.lock.wait(0.5)
                    continue
            final = job.build()
            with self.lock:
                job.building = False
                job.manual = False
                if final:
                    job.completed = max(job.completed, ticket)
                    try:
                        job.seen = job.signature()
                    except OSError:
                        pass
                self.lock.notify_all()

    # SyncTeX lookups run under the lock so a build cannot replace the index mid-query.
    def forward(self, path, line=None):
        with self.lock:
            project = self.require(path)
            result = project.index().forward(Path(path).expanduser().resolve(), line)
        if result is None:
            raise ValueError('That file does not appear in the last build.')
        return dict(result, pdf=str(project.pdf))

    def inverse(self, pdf, page, x, y):
        with self.lock:
            result = self.require(pdf).index().inverse(int(page), float(x), float(y))
        if result is None:
            raise ValueError('No source found on that page.')
        return result

    def page_sources(self, path, page):
        with self.lock:
            project = self.require(path)
            return {'pdf': str(project.pdf), 'page': int(page), 'sources': project.index().page_sources(int(page))}
