"""Verify durable state, concurrent browser updates, and restart recovery."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from workspace import Workspace


class WorkspaceTests(unittest.TestCase):
    """Use isolated files so tests cannot change the user's saved reading session."""

    def setUp(self):
        """Create two documents and a dedicated state file for each case."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.first = self.root / 'first.md'
        self.second = self.root / 'second.md'
        self.first.write_text('# First')
        self.second.write_text('# Second')
        self.state = self.root / 'state/workspace.json'
        self.workspace = Workspace(self.state)

    def open_both(self):
        """Create a representative workspace with two ordered document tabs."""
        for path in (self.first, self.second):
            self.workspace.action({'action': 'open-file', 'path': str(path)})

    def test_folder_addition_preserves_tabs_and_restart_restores_view(self):
        """Adding folders keeps tabs, positions, settings, and recent paths across reloads."""
        self.open_both()
        self.workspace.action({'action': 'open-folder', 'path': str(self.root)})
        self.workspace.action({'action': 'theme', 'path': 'dark'})
        self.workspace.action({'action': 'scroll', 'top': 320})
        self.workspace.action({'action': 'reorder-tabs', 'paths': [str(self.second), str(self.first)]})
        restored = Workspace(self.state).data
        self.assertEqual(restored['tabs'], [{'path': str(self.second), 'scroll': 320, 'group': None}, {'path': str(self.first), 'scroll': 0, 'group': None}])
        self.assertEqual(restored['folders'], [str(self.root)])
        self.assertEqual(restored['theme'], 'dark')
        self.assertEqual(restored['recentFiles'][0], str(self.second))
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

    def test_stale_browser_cannot_overwrite_new_tabs(self):
        """Reject a browser snapshot taken before another client opened a document."""
        self.workspace.action({'action': 'open-file', 'path': str(self.first)})
        stale = copy.deepcopy(self.workspace.data)
        self.workspace.action({'action': 'open-file', 'path': str(self.second)})
        self.assertFalse(self.workspace.sync(stale['revision'], stale))
        self.assertEqual(len(Workspace(self.state).data['tabs']), 2)

    def test_atomic_failure_preserves_previous_state(self):
        """A failed replacement leaves the last good workspace on disk and in memory."""
        self.open_both()
        previous = copy.deepcopy(self.workspace.data)
        with patch('workspace.os.replace', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.workspace.action({'action': 'theme', 'path': 'dark'})
        self.assertEqual(self.workspace.data, previous)
        self.assertEqual(json.loads(self.state.read_text()), previous)

    def test_missing_files_are_not_forgotten(self):
        """Keep missing tabs during restart so restoring their files can recover them."""
        self.open_both()
        self.first.unlink()
        restored = Workspace(self.state)
        self.assertEqual(len(restored.data['tabs']), 2)
        self.assertEqual(restored.data['tabs'][0]['path'], str(self.first))

    def test_invalid_and_duplicate_reorders_do_not_change_state(self):
        """Reject incomplete tab orders and unsupported paths without a partial save."""
        self.open_both()
        previous = copy.deepcopy(self.workspace.data)
        with self.assertRaises(ValueError):
            self.workspace.action({'action': 'reorder-tabs', 'paths': [str(self.first), str(self.first)]})
        with self.assertRaises(FileNotFoundError):
            self.workspace.action({'action': 'open-file', 'path': str(self.root / 'missing.md')})
        self.assertEqual(self.workspace.data, previous)

    def test_corrupt_state_is_not_overwritten(self):
        """Fail visibly when state is damaged instead of silently erasing the workspace."""
        self.open_both()
        self.state.write_text('{bad json')
        with self.assertRaises(ValueError):
            Workspace(self.state)
        self.assertEqual(self.state.read_text(), '{bad json')


if __name__ == '__main__':
    unittest.main()
