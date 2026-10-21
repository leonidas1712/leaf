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

    def test_cli_style_anchor_enrichment_and_changed_passage(self):
        """Quote-only creation captures context and locates an edited passage by surroundings."""
        self.path.write_text('# Project\n## Migration\n\nThis introductory paragraph explains the goal of the change and provides enough surrounding context for a review.\n')
        self.w.action({'action': 'comment-add', 'path': str(self.path), 'body': 'Clarify',
                       'anchor': {'quote': 'explains the goal of the change', 'prefix': '', 'suffix': '', 'heading': ''}})
        thread = self.w.data['comments'][-1]
        self.assertEqual(thread['anchor']['heading'], 'Project › Migration')
        self.assertTrue(12 <= len(thread['anchor']['prefix']) <= 32)
        self.assertTrue(12 <= len(thread['anchor']['suffix']) <= 32)
        self.path.write_text(self.path.read_text().replace('explains the goal of the change', 'describes what the migration changes'))
        result = list_comments(self.w.data)[-1]
        self.assertEqual(result['location'], {'state': 'changed', 'line': 4, 'endLine': 4})
        self.assertIn('changed · line 4', markdown_comments([result]))
        self.assertEqual(thread['anchor']['quote'], 'explains the goal of the change')

    def test_context_fallback_rejects_weak_duplicate_and_distant_surroundings(self):
        """Changed-text matching needs long unique context and a bounded nonempty gap."""
        anchor = {'quote': 'original phrase', 'prefix': 'unique context before ', 'suffix': ' context after passage'}
        thread = {'anchor': anchor}
        valid = anchor['prefix'] + 'new phrase' + anchor['suffix']
        self.assertEqual(locate(thread, valid)['state'], 'changed')
        for source in (valid + '\n' + valid, anchor['prefix'] + 'x' * 300 + anchor['suffix'],
                       anchor['prefix'] + anchor['suffix'], 'new phrase'):
            self.assertEqual(locate(thread, source)['state'], 'detached')
        self.assertEqual(locate({'anchor': dict(anchor, prefix='tiny')}, 'tinynew phrase' + anchor['suffix'])['state'], 'detached')

    def test_enrichment_does_not_guess_or_replace_explicit_context(self):
        """Ambiguous quotes remain unfilled and explicit selectors retain user intent."""
        from comments import enrich_anchor, heading_trail
        self.assertEqual(enrich_anchor({'quote': 'same'}, 'same and same'), {'quote': 'same'})
        explicit = {'quote': 'text', 'prefix': 'custom', 'suffix': 'kept', 'heading': 'Manual'}
        self.assertEqual(enrich_anchor(explicit, 'before text after'), explicit)
        source = '# Parent\n```md\n# Fake\n```\n## Child\npassage'
        self.assertEqual(heading_trail(source, source.index('passage')), 'Parent › Child')
        result = list_comments(self.w.data)[0]
        result['anchor']['heading'] = ''
        self.assertNotIn('Heading:', markdown_comments([result]))

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
