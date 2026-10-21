#!/usr/bin/env python3
"""Install a checkout-backed Leaf command and optional Codex skill without dependencies."""
import argparse
from pathlib import Path
import shlex
import sys


def main():
    """Create an executable launcher while leaving documents and saved state intact."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    parser.add_argument('--skill', action='store_true', help='Install the skill into ~/.codex/skills/leaf')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
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
