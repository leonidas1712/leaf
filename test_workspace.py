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

    def test_split_shows_two_documents_and_follows_focus(self):
        """Splitting places the target on the requested side; tab focus moves within the split."""
        self.open_both()
        third = self.root / 'third.md'
        third.write_text('# Third')
        first, second = str(self.first), str(self.second)
        data = self.workspace.action({'action': 'split', 'path': first, 'side': 'right'})
        self.assertEqual(data['split'], {'panes': [second, first], 'focus': 1, 'layout': 'columns', 'ratio': .5})
        self.assertEqual(data['active'], first)
        data = self.workspace.action({'action': 'focus-tab', 'path': second})
        self.assertEqual((data['split']['panes'], data['split']['focus']), ([second, first], 0))
        data = self.workspace.action({'action': 'open-file', 'path': str(third)})
        self.assertEqual((data['split']['panes'], data['split']['focus']), ([str(third), first], 0))
        data = self.workspace.action({'action': 'split-resize', 'ratio': .65})
        self.assertEqual(Workspace(self.state).data['split']['ratio'], .65)
        data = self.workspace.action({'action': 'close-tab', 'path': str(third)})
        self.assertIsNone(data['split'])
        self.assertEqual(data['active'], first)

    def test_split_opens_documents_and_rejects_invalid_requests(self):
        """A split can open its target, stacks for up and down, and refuses impossible layouts."""
        self.workspace.action({'action': 'open-file', 'path': str(self.first)})
        previous = copy.deepcopy(self.workspace.data)
        for command in ({'action': 'split'}, {'action': 'split', 'side': 'middle'},
                        {'action': 'split', 'path': str(self.second), 'ratio': .95}, {'action': 'split-resize', 'ratio': .5},
                        {'action': 'unsplit', 'path': str(self.first)}):
            with self.assertRaises(ValueError):
                self.workspace.action(command)
        self.assertEqual(self.workspace.data, previous)
        data = self.workspace.action({'action': 'split', 'path': str(self.second), 'side': 'up'})
        self.assertEqual(data['split']['panes'], [str(self.second), str(self.first)])
        self.assertEqual(data['split']['layout'], 'rows')
        self.assertEqual(data['recentFiles'][0], str(self.second))
        data = self.workspace.action({'action': 'unsplit', 'path': str(self.first)})
        self.assertEqual((data['split'], data['active']), (None, str(self.first)))
        self.assertEqual(len(data['tabs']), 2)

    def test_closing_the_other_pane_ends_the_split(self):
        """Closing the unfocused pane's tab collapses the reader to the focused document."""
        self.open_both()
        self.workspace.action({'action': 'split', 'path': str(self.first), 'side': 'left'})
        data = self.workspace.action({'action': 'close-tab', 'path': str(self.second)})
        self.assertIsNone(data['split'])
        self.assertEqual(data['active'], str(self.first))

    def test_agents_keep_the_document_being_edited_on_screen(self):
        """Agent opens split beside the editor or use the other pane; focus stays with the user."""
        third = self.root / 'third.md'
        third.write_text('# Third')
        first, second = str(self.first), str(self.second)
        self.workspace.action({'action': 'open-file', 'path': first})
        editing = {first}
        data = self.workspace.action({'action': 'open-file', 'path': second, 'origin': 'agent'}, editing)
        self.assertEqual((data['active'], data['split']['panes'], data['split']['focus']), (first, [first, second], 0))
        data = self.workspace.action({'action': 'open-file', 'path': str(third), 'origin': 'agent'}, editing)
        self.assertEqual((data['active'], data['split']['panes']), (first, [first, str(third)]))
        data = self.workspace.action({'action': 'focus-tab', 'path': second, 'origin': 'agent'}, editing)
        self.assertEqual(data['split']['panes'], [first, second])
        data = self.workspace.action({'action': 'split', 'path': str(third), 'side': 'left', 'beside': second, 'origin': 'agent'}, editing)
        self.assertEqual((data['active'], data['split']['panes'], data['split']['focus']), (first, [first, str(third)], 0))
        data = self.workspace.action({'action': 'unsplit', 'path': str(third), 'origin': 'agent'}, editing)
        self.assertEqual((data['active'], data['split']), (first, None))

    def test_agents_can_replace_or_open_in_the_background(self):
        """Replace takes over the user's pane; background opens a tab without showing it; readers are unaffected."""
        first, second = str(self.first), str(self.second)
        self.workspace.action({'action': 'open-file', 'path': first})
        data = self.workspace.action({'action': 'open-file', 'path': second, 'origin': 'agent', 'background': True}, {first})
        self.assertEqual((data['active'], data['split'], len(data['tabs'])), (first, None, 2))
        data = self.workspace.action({'action': 'focus-tab', 'path': second, 'origin': 'agent', 'replace': True}, {first})
        self.assertEqual((data['active'], data['split']), (second, None))
        data = self.workspace.action({'action': 'focus-tab', 'path': first, 'origin': 'agent'}, set())
        self.assertEqual((data['active'], data['split']), (first, None))
        data = self.workspace.action({'action': 'focus-tab', 'path': second}, {first})
        self.assertEqual((data['active'], data['split']), (second, None))

    def test_pins_are_ordered_durable_and_independent_of_tabs(self):
        """Pinning never opens a tab; closing a tab keeps its pin; index moves an existing pin."""
        first, second = str(self.first), str(self.second)
        data = self.workspace.action({'action': 'pin', 'path': first})
        self.assertEqual((data['pins'], data['tabs']), ([first], []))
        data = self.workspace.action({'action': 'pin', 'path': second, 'index': 0})
        self.assertEqual(data['pins'], [second, first])
        data = self.workspace.action({'action': 'pin', 'path': second})
        self.assertEqual(data['pins'], [second, first])
        data = self.workspace.action({'action': 'pin', 'path': second, 'index': 1})
        self.assertEqual(data['pins'], [first, second])
        self.workspace.action({'action': 'open-file', 'path': first})
        self.workspace.action({'action': 'close-tab', 'path': first})
        self.assertEqual(Workspace(self.state).data['pins'], [first, second])
        data = self.workspace.action({'action': 'unpin', 'path': first})
        self.assertEqual(data['pins'], [second])

    def test_pin_rejects_invalid_requests(self):
        """Only existing text documents pin, at an index inside the list; unpinning needs a pin."""
        (self.root / 'image.png').write_bytes(b'')
        for command in ({'action': 'pin', 'path': str(self.root / 'missing.md')}, {'action': 'pin', 'path': str(self.root / 'image.png')},
                        {'action': 'pin', 'path': str(self.root)}, {'action': 'pin', 'path': str(self.first), 'index': 3},
                        {'action': 'pin', 'path': str(self.first), 'index': True}, {'action': 'unpin', 'path': str(self.first)}):
            with self.assertRaises((ValueError, OSError)):
                self.workspace.action(command)
        self.assertEqual(self.workspace.data['pins'], [])

    def test_workspaces_saved_before_pins_load_without_them(self):
        """Older state files gain an empty pin list; malformed pins are dropped."""
        self.open_both()
        saved = json.loads(self.state.read_text())
        del saved['pins']
        self.state.write_text(json.dumps(saved))
        self.assertEqual(Workspace(self.state).data['pins'], [])
        saved['pins'] = [str(self.first), 'relative.md', 3, str(self.first)]
        self.state.write_text(json.dumps(saved))
        self.assertEqual(Workspace(self.state).data['pins'], [str(self.first)])

    def test_corrupt_state_is_not_overwritten(self):
        """Fail visibly when state is damaged instead of silently erasing the workspace."""
        self.open_both()
        self.state.write_text('{bad json')
        with self.assertRaises(ValueError):
            Workspace(self.state)
        self.assertEqual(self.state.read_text(), '{bad json')


if __name__ == '__main__':
    unittest.main()
