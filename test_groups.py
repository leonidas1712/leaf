"""Prove group lifecycle, canonical metadata protection, and reader validation."""
import copy
from pathlib import Path
import tempfile
import unittest
from workspace import Workspace


class GroupTests(unittest.TestCase):
    """Use disposable documents so group tests cannot change the live workspace."""

    def setUp(self):
        """Create three open documents and a durable workspace for each test."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = Workspace(self.root / 'state.json')
        self.paths = []
        for name in ('a', 'b', 'c'):
            path = self.root / (name + '.md')
            path.write_text('# ' + name)
            self.paths.append(str(path))
            self.workspace.action({'action': 'open-file', 'path': str(path)})

    def group(self):
        """Create a group with separated tabs to exercise contiguity normalization."""
        self.workspace.action({'action': 'group-create', 'name': 'Project', 'paths': [self.paths[0], self.paths[2]]})
        return self.workspace.data['groups'][0]['id']

    def test_close_reopen_and_restart_preserve_positions(self):
        """Closed groups retain their order and positions across process restarts."""
        group = self.group()
        self.workspace.action({'action': 'scroll', 'top': 250})
        self.workspace.action({'action': 'group-close', 'group': group})
        self.assertEqual([tab['path'] for tab in self.workspace.data['tabs']], [self.paths[1]])
        restored = Workspace(self.workspace.path)
        restored.action({'action': 'group-open', 'group': 'Project'})
        members = [tab for tab in restored.data['tabs'] if tab['group'] == group]
        self.assertEqual([tab['path'] for tab in members], [self.paths[0], self.paths[2]])
        self.assertEqual(members[1]['scroll'], 250)
        self.assertEqual(restored.data['groups'][0]['saved'], [])

    def test_view_only_and_legacy_sync_preserve_group_metadata(self):
        """Browser snapshots cannot replace groups, sources, or reader preferences."""
        group = self.group()
        self.workspace.action({'action': 'reader', 'fontSize': 20, 'font': 'serif'})
        view = copy.deepcopy(self.workspace.data)
        view.update(groups=[], sources={}, reader={}, tabs=[{'path': self.paths[0], 'scroll': 99}], active=self.paths[0])
        self.workspace.sync(self.workspace.data['revision'], view, view_only=True)
        self.assertEqual(len(self.workspace.data['tabs']), 3)
        self.assertEqual(self.workspace.data['tabs'][0]['scroll'], 99)
        self.assertEqual(self.workspace.data['groups'][0]['id'], group)
        self.assertEqual(self.workspace.data['reader']['fontSize'], 20)
        view = copy.deepcopy(self.workspace.data)
        for tab in view['tabs']:
            tab.pop('group')
        self.workspace.sync(self.workspace.data['revision'], view)
        self.assertEqual(self.workspace.data['tabs'][0]['group'], group)

    def test_invalid_mutations_are_atomic(self):
        """Invalid groups, reader sizes, and tab orders do not persist partial changes."""
        self.group()
        before = copy.deepcopy(self.workspace.data)
        for command in ({'action': 'group-create', 'name': 'Project'},
                        {'action': 'group-update', 'group': 'Project', 'name': 'Changed', 'color': 'invalid'},
                        {'action': 'group-add', 'group': 'Project', 'paths': ['/missing.md']},
                        {'action': 'reader', 'fontSize': float('nan')},
                        {'action': 'reorder-tabs', 'paths': self.paths}):
            with self.assertRaises(ValueError):
                self.workspace.action(command)
            self.assertEqual(before, self.workspace.data)

    def test_reopen_skips_document_already_open_elsewhere(self):
        """Reopening a closed group never duplicates or steals an independently opened tab."""
        group = self.group()
        self.workspace.action({'action': 'group-close', 'group': group})
        self.workspace.action({'action': 'open-file', 'path': self.paths[0]})
        self.workspace.action({'action': 'group-open', 'group': group})
        tabs = self.workspace.data['tabs']
        self.assertEqual(len(tabs), 3)
        self.assertIsNone(next(tab for tab in tabs if tab['path'] == self.paths[0])['group'])
        self.workspace.action({'action': 'group-delete', 'group': group})
        self.assertEqual(len(self.workspace.data['tabs']), 2)
        self.assertEqual(self.workspace.data['groups'], [])

    def test_move_tab_and_source_metadata_survive_reload(self):
        """Moving tabs preserves source provenance while reader settings persist."""
        group = self.group()
        self.workspace.action({'action': 'move-tab', 'path': self.paths[1], 'index': 0, 'group': group})
        self.assertEqual(self.workspace.data['tabs'][0]['path'], self.paths[1])
        source = {'kind': 'aboard', 'board': 'leaf', 'file': 'notes/plan.md', 'version': 2}
        self.workspace.action({'action': 'open-file', 'path': self.paths[0], 'source': source})
        self.workspace.action({'action': 'reader', 'width': 'wide'})
        self.workspace.action({'action': 'theme', 'path': 'system'})
        restored = Workspace(self.workspace.path).data
        self.assertEqual(restored['sources'][self.paths[0]], source)
        self.assertEqual(restored['reader']['width'], 'wide')
        self.assertEqual(restored['theme'], 'system')
