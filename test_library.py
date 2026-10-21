"""Verify virtual collections retain references and enforce a valid nested hierarchy."""
import copy
from pathlib import Path
import tempfile
import unittest
from workspace import Workspace
from library import resolve_collection


class CollectionTests(unittest.TestCase):
    """Exercise collection actions against disposable documents and saved state."""

    def setUp(self):
        """Create a root and child collection with distinct documents."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.paths = [str(self.root / name) for name in ('one.md', 'two.md')]
        for path in self.paths:
            Path(path).write_text('# Document')
        self.w = Workspace(self.root / 'state.json')
        self.w.action({'action': 'collection-create', 'name': 'Atlas', 'color': 'green', 'paths': [self.paths[0]]})
        self.w.action({'action': 'collection-create', 'name': 'Plans', 'parent': 'Atlas', 'paths': [self.paths[1]]})

    def test_cycles_and_sibling_collisions_leave_state_unchanged(self):
        """Illegal hierarchy mutations cannot partially persist a collection tree."""
        before = copy.deepcopy(self.w.data)
        for command in ({'action': 'collection-move', 'collection': 'Atlas', 'parent': 'Atlas/Plans'},
                        {'action': 'collection-create', 'name': 'Plans', 'parent': 'Atlas'},
                        {'action': 'collection-update', 'collection': 'Atlas', 'name': 'Bad/Name'},
                        {'action': 'collection-move', 'collection': 'Atlas/Plans', 'index': -1}):
            with self.assertRaises(ValueError):
                self.w.action(command)
            self.assertEqual(before, self.w.data)

    def test_open_reuses_group_and_preserves_missing_docs(self):
        """Recursive open deduplicates references and keeps unavailable documents recoverable."""
        self.w.action({'action': 'collection-add', 'collection': 'Atlas/Plans', 'paths': [self.paths[0]]})
        Path(self.paths[1]).unlink()
        self.w.action({'action': 'collection-open', 'collection': 'Atlas'})
        self.assertEqual([tab['path'] for tab in self.w.data['tabs']], self.paths)
        group = self.w.data['groups'][0]
        self.assertEqual(group['color'], 'green')
        self.w.action({'action': 'group-close', 'group': group['id']})
        self.w.action({'action': 'collection-open', 'collection': 'Atlas'})
        self.assertEqual(len(self.w.data['groups']), 1)
        restored = Workspace(self.w.path)
        self.assertEqual(restored.data['collections'], self.w.data['collections'])

    def test_delete_does_not_close_tabs_or_delete_files(self):
        """Deleting a collection subtree removes references while retaining open tabs and files."""
        self.w.action({'action': 'collection-open', 'collection': 'Atlas'})
        key = 'collection:' + self.w.data['collections'][0]['id']
        view = copy.deepcopy(self.w.data)
        view['expanded'] = [key]
        self.w.sync(self.w.data['revision'], view, view_only=True)
        self.w.action({'action': 'collection-delete', 'collection': 'Atlas'})
        self.assertEqual(self.w.data['collections'], [])
        self.assertEqual(self.w.data['expanded'], [])
        self.assertEqual(len(self.w.data['tabs']), 2)
        self.assertNotIn('collection', self.w.data['groups'][0])
        self.assertTrue(all(Path(path).exists() for path in self.paths))

    def test_move_and_document_order(self):
        """Sibling moves and document insertions preserve explicit user order."""
        self.w.action({'action': 'collection-create', 'name': 'Other'})
        self.w.action({'action': 'collection-move', 'collection': 'Atlas/Plans', 'parent': None, 'index': 0})
        self.assertEqual(self.w.data['collections'][0]['name'], 'Plans')
        self.w.action({'action': 'collection-add', 'collection': 'Plans', 'paths': [self.paths[0]], 'index': 0})
        self.assertEqual(resolve_collection(self.w.data, 'Plans')['docs'], self.paths)
        self.w.action({'action': 'collection-remove', 'collection': 'Plans', 'paths': [self.paths[0]]})
        self.assertEqual(resolve_collection(self.w.data, 'Plans')['docs'], [self.paths[1]])

    def test_view_only_sync_cannot_erase_collections(self):
        """Expansion accepts existing collection keys but rejects invented identifiers."""
        key = 'collection:' + self.w.data['collections'][0]['id']
        self.w.sync(self.w.data['revision'], {'expanded': [key], 'collections': []}, view_only=True)
        self.assertEqual(len(self.w.data['collections']), 2)
        with self.assertRaises(ValueError):
            self.w.sync(self.w.data['revision'], {'expanded': ['collection:unknown']}, view_only=True)

    def test_aboard_collection_add_records_provenance_without_opening(self):
        """Adding a cached board file preserves provenance without changing the reading workspace."""
        source = {'kind': 'aboard', 'server': 'https://aboard.example', 'board': 'leaf', 'file': 'plan.md', 'version': 1}
        self.w.action({'action': 'collection-add', 'collection': 'Atlas', 'paths': [self.paths[1]], 'sources': {self.paths[1]: source}})
        self.assertEqual(self.w.data['sources'][self.paths[1]], source)
        self.assertEqual(self.w.data['tabs'], [])
