"""Prove comments survive edits and retain a canonical, timestamped timeline."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from comments import list_comments, locate, markdown_comments
from workspace import Workspace


class CommentTests(unittest.TestCase):
    """Use disposable documents so tests cannot alter a reader's saved discussions."""

    def setUp(self):
        """Create one Markdown document and an independent workspace."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'plan.md'
        self.path.write_text('# Plan\n\nA **bold** statement.\n')
        self.w = Workspace(Path(self.temp.name) / 'workspace.json')
        self.w.action({'action': 'comment-add', 'path': str(self.path), 'body': 'Clarify',
                       'anchor': {'quote': 'A bold statement.'}, 'author': 'you'})
        self.id = self.w.data['comments'][0]['id']

    def test_timeline_survives_sync_restart_and_file_removal(self):
        """Status history remains intact through stale sync, persistence and lost text."""
        old = copy.deepcopy(self.w.data)
        for status in ('working', 'resolved', 'open'):
            self.w.action({'action': 'comment-status', 'id': self.id, 'status': status, 'author': 'codex', 'note': status})
        self.assertFalse(self.w.sync(old['revision'], old))
        forged = copy.deepcopy(self.w.data)
        forged['comments'] = []
        self.w.sync(forged['revision'], forged)
        restored = Workspace(self.w.path)
        thread = restored.data['comments'][0]
        self.assertEqual([r['status'] for r in thread['replies']], ['working', 'resolved', 'open'])
        self.assertTrue(all(r['created'].endswith('Z') for r in thread['replies']))
        self.path.unlink()
        result = list_comments(restored.data)
        self.assertEqual(result[0]['location']['state'], 'detached')
        self.assertIn('marked resolved: resolved', markdown_comments(result))

    def test_locations_track_source_lines_and_ambiguity(self):
        """Rendered quotes map to source lines and duplicate matches never guess."""
        thread = self.w.data['comments'][0]
        self.assertEqual(list_comments(self.w.data)[0]['location']['line'], 3)
        self.path.write_text('Intro\n\n# Plan\n\nA **bold** statement.\n')
        self.assertEqual(list_comments(self.w.data)[0]['location']['line'], 5)
        self.assertEqual(locate(thread, 'A bold statement.\nA bold statement.')['state'], 'ambiguous')
        thread = dict(thread, anchor={'quote': 'same', 'prefix': 'second'})
        self.assertEqual(locate(thread, 'first same\nsecond same')['line'], 2)
        self.assertEqual(locate(dict(thread, anchor=None), None), {'state': 'attached', 'line': None, 'endLine': None})
        thread['anchor'] = {'quote': 'A link here'}
        self.assertEqual(locate(thread, '# A [link](https://example.test) here')['line'], 1)

    def test_invalid_mutations_and_disk_failure_are_atomic(self):
        """Validation and persistence failures cannot partially modify thread state."""
        before = copy.deepcopy(self.w.data)
        for extra in ({'action': 'comment-status', 'status': 'lost'},
                      {'action': 'comment-reply', 'body': ''},
                      {'action': 'comment-anchor', 'anchor': {'quote': ''}},
                      {'action': 'comment-edit', 'body': 'text', 'reply': 'missing'}):
            with self.assertRaises(ValueError):
                self.w.action(dict(extra, id=self.id))
            self.assertEqual(self.w.data, before)
        with patch.object(self.w, 'save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.w.action({'action': 'comment-reply', 'id': self.id, 'body': 'Answer'})
        self.assertEqual(self.w.data, before)

    def test_edit_reply_remove_and_reattach_preserve_source(self):
        """Explicit thread operations affect only Leaf state, never document bytes."""
        source = self.path.read_bytes()
        self.w.action({'action': 'comment-reply', 'id': self.id, 'body': 'Answer'})
        reply = self.w.data['comments'][0]['replies'][0]['id']
        self.w.action({'action': 'comment-edit', 'id': self.id, 'reply': reply, 'body': 'Revised'})
        self.assertIn('edited', self.w.data['comments'][0]['replies'][0])
        self.w.action({'action': 'comment-anchor', 'id': self.id, 'anchor': None})
        self.w.action({'action': 'comment-delete', 'id': self.id, 'reply': reply})
        self.assertEqual(self.w.data['comments'][0]['replies'], [])
        self.w.action({'action': 'comment-delete', 'id': self.id})
        self.assertEqual(self.w.data['comments'], [])
        self.assertEqual(self.path.read_bytes(), source)
