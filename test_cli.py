"""Verify CLI discovery and installation without touching the user's running reader."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parent


class CliTests(unittest.TestCase):
    """Exercise real command parsing and a fresh installation in isolated directories."""

    def test_discovery_does_not_start_server(self):
        """Help, guides, and typo errors must leave an isolated state directory absent."""
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            env = dict(os.environ, LEAF_STATE_DIR=str(state))
            for arguments, code in [([], 0), (['help'], 0), (['help', 'open'], 0),
                                    (['--help'], 0), (['hepl'], 2), (['theme', 'blue'], 2),
                                    (['scroll'], 2), (['guide'], 0), (['skill'], 0)]:
                result = subprocess.run([sys.executable, str(BASE / 'leaf.py'), *arguments], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertFalse(state.exists())

    def test_installed_launcher_from_other_directory(self):
        """An installed command must find assets and emit JSON outside the checkout."""
        import json
        with tempfile.TemporaryDirectory(prefix='leaf install ') as directory:
            env = dict(os.environ, LEAF_STATE_DIR=str(Path(directory) / 'state'))
            result = subprocess.run([sys.executable, str(BASE / 'install.py'), '--bin-dir', directory, '--skip-build'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(Path(directory) / 'leaf'), 'status', '--json'], cwd=directory, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'stopped')
            self.assertFalse((Path(directory) / 'state').exists())

    def test_frontend_build_uses_locked_dependencies_and_checks_output(self):
        """Use npm ci before build and reject a successful process without artifacts."""
        from unittest.mock import patch
        import install
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'web').mkdir()
            (root / 'web/package-lock.json').write_text('{}')
            with patch.object(install.shutil, 'which', return_value='/node/bin/npm'), patch.object(install.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'did not produce'):
                    install.build_frontend(root)
                self.assertEqual(run.call_args_list[0].args[0][1], 'ci')
                self.assertEqual(run.call_args_list[1].args[0][1:], ['run', 'build'])
                (root / 'web/dist').mkdir()
                (root / 'web/dist/index.html').write_text('Leaf')
                install.build_frontend(root)


if __name__ == '__main__':
    unittest.main()
