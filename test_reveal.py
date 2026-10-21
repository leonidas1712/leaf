"""Verify file-manager launches stay within known paths and preserve saved state."""
import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from reveal import reveal_path
from workspace import empty_workspace


class RevealTests(unittest.TestCase):
    """Mock desktop launches while checking real path containment and filesystem errors."""

    def test_known_paths_and_platform_arguments_preserve_state(self):
        """Known files, collection references and subfolders use safe argv without mutation."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            folder = root / 'library'
            nested = folder / 'nested'
            nested.mkdir(parents=True)
            doc = nested / 'space ; $(test).md'
            doc.write_text('sample')
            collection_doc = root / 'collection.md'
            collection_doc.write_text('sample')
            state = empty_workspace()
            state['folders'] = [str(folder)]
            state['collections'] = [{'docs': [str(collection_doc)]}]
            before = copy.deepcopy(state)
            with patch('reveal.sys.platform', 'darwin'), patch('reveal.subprocess.run', return_value=Mock(returncode=0)) as run:
                for path in (doc, folder, nested, collection_doc):
                    self.assertEqual(reveal_path(str(path), state, [doc]), {'status': 'revealed'})
                    self.assertEqual(run.call_args.args[0], ['open', '-R', str(path)])
                    self.assertNotIn('shell', run.call_args.kwargs)
            with patch('reveal.sys.platform', 'linux'), patch('reveal.subprocess.run', return_value=Mock(returncode=0)) as run:
                reveal_path(str(doc), state, [doc])
                self.assertEqual(run.call_args.args[0], ['xdg-open', str(nested)])
                reveal_path(str(folder), state, [])
                self.assertEqual(run.call_args.args[0], ['xdg-open', str(folder)])
            self.assertEqual(state, before)

    def test_unknown_missing_and_escaping_paths_never_launch(self):
        """Unlisted files and symlinks out of sidebar roots cannot reach the file manager."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            folder = root / 'library'
            folder.mkdir()
            outside = root / 'outside.md'
            outside.write_text('sample')
            ungranted = folder / 'ungranted.md'
            ungranted.write_text('sample')
            link = folder / 'escape.md'
            link.symlink_to(outside)
            state = empty_workspace()
            state['folders'] = [str(folder)]
            with patch('reveal.subprocess.run') as run:
                for path in (outside, ungranted, link, root / 'missing.md', Path('relative.md')):
                    with self.assertRaises(ValueError):
                        reveal_path(str(path), state, [link, outside])
                run.assert_not_called()
                state['folders'] = []
                with self.assertRaises(ValueError):
                    reveal_path(str(ungranted), state, [ungranted])

    def test_launch_errors_are_clear(self):
        """Missing desktop tools, timeouts and rejected launches return operational errors."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            state = empty_workspace()
            state['folders'] = [str(root)]
            with patch('reveal.sys.platform', 'darwin'):
                for error in (FileNotFoundError(), subprocess.TimeoutExpired('open', 5), OSError('failed')):
                    with patch('reveal.subprocess.run', side_effect=error), self.assertRaises(ValueError):
                        reveal_path(str(root), state, [])
                with patch('reveal.subprocess.run', return_value=Mock(returncode=1)), self.assertRaises(ValueError):
                    reveal_path(str(root), state, [])
