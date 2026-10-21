"""Reveal known workspace paths in the operating system's file manager."""
from pathlib import Path
import subprocess
import sys


def reveal_path(value, workspace, granted):
    """Validate current path membership and launch the file manager without changing state."""
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError('Reveal requires an absolute path known to Leaf.')
    try:
        path = Path(value).resolve(strict=True)
    except (OSError, ValueError, RuntimeError) as error:
        raise ValueError('The path is missing or unavailable.') from error
    if not path.is_file() and not path.is_dir():
        raise ValueError('Reveal requires a regular file or folder.')
    known = set(workspace['files'] + workspace['folders'])
    known.update(tab['path'] for tab in workspace['tabs'])
    known.update(doc for collection in workspace['collections'] for doc in collection['docs'])
    roots = []
    for value in workspace['folders']:
        root = Path(value)
        # A replaced sidebar root must not silently grant a different directory tree.
        if root.is_dir() and root.resolve() == root:
            roots.append(root)
    inside = any(path.is_relative_to(root) for root in roots)
    allowed = str(path) in known or (inside and (path.is_dir() or path in set(granted)))
    if not allowed:
        raise ValueError('This path is not known to Leaf. Open it or add its folder first.')
    if sys.platform == 'darwin':
        argv = ['open', '-R', str(path)]
    elif sys.platform.startswith('linux'):
        argv = ['xdg-open', str(path if path.is_dir() else path.parent)]
    else:
        raise ValueError('Reveal is supported on macOS and Linux only.')
    try:
        result = subprocess.run(argv, capture_output=True, timeout=5, check=False)
    except FileNotFoundError as error:
        raise ValueError('The system file manager command is unavailable.') from error
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError('The system file manager did not respond. Try again.') from error
    if result.returncode:
        raise ValueError('The system file manager could not reveal this path.')
    return {'status': 'revealed'}
