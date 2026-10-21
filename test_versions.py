"""Exercise exact-byte history, conflict preservation and native edit reconciliation."""
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
from versions import VersionStore, Changed, digest, merge_text
from editing import Editing
from workspace import Workspace


class VersionTests(unittest.TestCase):
    """Use disposable documents and databases without touching the reader workspace."""

    def setUp(self):
        """Create an independent source document and owner-private history directory."""
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.path = self.root / 'document.md'
        self.path.write_bytes(b'one\r\ntwo\r\nthree\r\n')
        self.store = VersionStore(self.root / 'state' / 'history')

    def tearDown(self):
        """Release SQLite before removing disposable files."""
        self.store.close()
        self.temp.cleanup()

    def test_exact_bytes_dedup_and_stale_save(self):
        """A stale save preserves external bytes and supplies an exact recovery snapshot."""
        original = self.store.current(self.path)
        self.assertEqual(original['hash'], digest(self.path.read_bytes()))
        self.assertEqual(self.store.current(self.path), original)
        self.path.write_bytes(b'other\r\n')
        with self.assertRaises(Changed) as error:
            self.store.save(self.path, original['hash'], 'mine\n')
        self.assertEqual(error.exception.current['text'], 'other\r\n')
        self.assertEqual(self.path.read_bytes(), b'other\r\n')
        self.assertEqual(len(self.store.history(self.path)['versions']), 2)
        self.assertEqual(self.store.content(self.path, original['version']), original['text'])

    def test_atomic_save_restore_and_permissions(self):
        """Writes retain file permissions and snapshots remain readable after reopening SQLite."""
        os.chmod(self.path, 0o640)
        original = self.store.current(self.path)
        saved = self.store.save(self.path, original['hash'], 'new\n')['version']
        restored = self.store.save(self.path, saved['hash'], original['text'], kind='restore')['version']
        self.assertEqual(restored['kind'], 'restore')
        self.assertEqual(self.path.read_bytes(), original['text'].encode())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.root / 'state/history/versions.sqlite3').stat().st_mode & 0o777, 0o600)
        self.store.close()
        self.store = VersionStore(self.root / 'state/history')
        self.assertEqual(self.store.content(self.path, saved['id']), 'new\n')

    def test_checkout_detects_lost_observed_changes(self):
        """Checkin retains competing edits even when passive observation already saw the overwrite."""
        base = self.store.checkout(self.path, 'codex')
        self.assertEqual(self.store.checkout(self.path, 'codex'), base)
        current = self.store.current(self.path)
        other = self.store.save(self.path, current['hash'], 'one\r\ntwo\r\nOTHER\r\n')['version']
        self.path.write_bytes(b'MINE\r\ntwo\r\nthree\r\n')
        self.store.observe(self.path)
        result = self.store.checkin(self.path, 'codex', 'native edit')
        self.assertEqual(result['status'], 'overwrote')
        self.assertEqual(result['theirs'], other['id'])
        self.assertEqual(self.store.base(self.path, 'codex'), base['base'])
        self.assertTrue(any(row['base'] for row in self.store.history(self.path)['versions']))
        merged, conflict = merge_text(self.store.content(self.path, base['base']), self.path.read_bytes().decode(), self.store.content(self.path, other['id']))
        self.assertFalse(conflict)
        self.assertIn('MINE', merged)
        self.assertIn('OTHER', merged)

    def test_conflict_merge_and_clean_checkin(self):
        """Three-way conflicts retain both edits; an uncontested checkout signs and releases."""
        text, conflict = merge_text('base\n', 'mine\n', 'theirs\n')
        self.assertTrue(conflict)
        self.assertIn('<<<<<<< mine', text)
        self.assertIn('theirs', text)
        self.store.checkout(self.path, 'codex')
        self.path.write_text('signed\n')
        result = self.store.checkin(self.path, 'codex', 'note')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['version']['author'], 'codex')
        self.assertIsNone(self.store.base(self.path, 'codex'))

    def test_retention_pins_old_checkout(self):
        """Pruning retains the newest 200, recent records and an old active checkout base."""
        base = self.store.checkout(self.path, 'agent')['base']
        for number in range(205):
            self.store.record(self.path, str(number).encode())
        self.store.db.execute("UPDATE versions SET at='2000-01-01T00:00:00Z'")
        self.store.db.commit()
        self.store.prune(self.path)
        self.assertIsNotNone(self.store.row(self.path, base))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM versions').fetchone()[0], 201)
        self.store.end(self.path, 'agent')
        self.store.prune(self.path)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM versions').fetchone()[0], 200)

    def test_path_scope_and_invalid_bytes(self):
        """Snapshot IDs cannot read another path and binary text never becomes a snapshot."""
        original = self.store.current(self.path)
        with self.assertRaises(ValueError):
            self.store.content(self.root / 'other.md', original['version'])
        self.path.write_bytes(b'\xff')
        with self.assertRaises(ValueError):
            self.store.current(self.path)

    def test_editing_authorization_presence_and_restore(self):
        """Only known local text can be saved; stale sync cannot erase advisory presence."""
        workspace = Workspace(self.root / 'workspace-state/workspace.json')
        editing = Editing(workspace, {})
        try:
            with self.assertRaises(ValueError):
                editing.path(str(self.path), write=True)
            workspace.action({'action': 'open-file', 'path': str(self.path)})
            result = editing.action({'action': 'edit-start', 'path': str(self.path), 'author': 'codex'})
            base = result['presence']['base']
            self.assertEqual(workspace.data['editing'][str(self.path)]['base'], base)
            current = editing.store.current(self.path)
            editing.save({'path': str(self.path), 'base': current['hash'], 'text': 'new', 'author': 'codex'})
            self.assertEqual(workspace.data['editing'], {})
            with self.assertRaises(Changed):
                editing.action({'action': 'restore', 'path': str(self.path), 'version': base, 'base': current['hash']})
            workspace.data['sources'][str(self.path)] = {'kind': 'aboard'}
            with self.assertRaises(ValueError):
                editing.save({'path': str(self.path), 'base': current['hash'], 'text': 'bad'})
            del workspace.data['sources'][str(self.path)]
            self.path.unlink()
            target = self.root / 'target.md'
            target.write_text('target')
            self.path.symlink_to(target)
            with self.assertRaises(ValueError):
                editing.path(str(self.path), write=True)
        finally:
            editing.store.close()

    def test_save_rechecks_after_temporary_file_write(self):
        """A native write during temporary-file preparation is captured and never replaced."""
        from versions import read_bytes
        original = self.store.current(self.path)
        calls = 0

        def racing_read(path):
            """Change disk immediately before the final compare-and-swap check."""
            nonlocal calls
            calls += 1
            if calls == 2:
                self.path.write_bytes(b'native winner\n')
            return read_bytes(path)

        with patch('versions.read_bytes', side_effect=racing_read):
            with self.assertRaises(Changed):
                self.store.save(self.path, original['hash'], 'must not land')
        self.assertEqual(self.path.read_bytes(), b'native winner\n')
        self.assertEqual(list(self.root.glob('.leaf-save-*')), [])
