#!/usr/bin/env python3
"""Install a checkout-backed Leaf command and optional Codex skill without dependencies."""
import argparse
from pathlib import Path
import shlex
import os
import shutil
import subprocess
import sys


def build_frontend(source):
    """Build locked frontend dependencies with Node available only at install time."""
    web = source / 'web'
    if not (web / 'package-lock.json').is_file():
        raise RuntimeError('Frontend lockfile missing. Finish the frontend scaffold before building.')
    npm = shutil.which('npm')
    if not npm:
        candidates = list((Path.home() / '.nvm/versions/node').glob('*/bin/npm'))
        candidates.sort(key=lambda path: tuple(int(part) for part in path.parent.parent.name.lstrip('v').split('.')), reverse=True)
        npm = str(candidates[0]) if candidates else None
    if not npm:
        raise RuntimeError('Node.js and npm are required to build Leaf. Install Node, then run python3 install.py --build.')
    env = dict(os.environ, PATH=str(Path(npm).parent) + os.pathsep + os.environ.get('PATH', ''))
    subprocess.run([npm, 'ci', '--no-audit', '--no-fund'], cwd=web, env=env, check=True)
    subprocess.run([npm, 'run', 'build'], cwd=web, env=env, check=True)
    if not (web / 'dist/index.html').is_file():
        raise RuntimeError('Build did not produce web/dist/index.html.')


def main():
    """Create an executable launcher while leaving documents and saved state intact."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    parser.add_argument('--skill', action='store_true', help='Install the skill into ~/.codex/skills/leaf')
    build = parser.add_mutually_exclusive_group()
    build.add_argument('--build', action='store_true', help='Install locked npm dependencies and rebuild the frontend')
    build.add_argument('--skip-build', action='store_true', help='Install the launcher without building frontend assets')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    needs_build = (source / 'web/package.json').exists() and not (source / 'web/dist/index.html').exists()
    if args.build or (needs_build and not args.skip_build):
        try:
            build_frontend(source)
        except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
            parser.exit(1, str(error) + '\n')
    destination = args.bin_dir.expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    launcher = destination / 'leaf'
    launcher.write_text('#!/bin/sh\n# Installed by Leaf; keep the source checkout in place.\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(source / 'leaf.py')) + ' "$@"\n')
    launcher.chmod(0o755)
    if args.skill:
        target = Path.home() / '.codex/skills/leaf'
        target.parent.mkdir(parents=True, exist_ok=True)
        expected = source / 'skills/leaf'
        if target.is_symlink() and target.resolve() == expected:
            pass
        elif target.exists() or target.is_symlink():
            parser.error(f'Skill already exists at {target}; it was not replaced.')
        else:
            target.symlink_to(expected, target_is_directory=True)
        print(f'Agent skill: {target}')
    print(f'Installed: {launcher}\nSource: {source}\nRun: leaf help\nAdd {destination} to PATH if needed.')


if __name__ == '__main__':
    main()
