"""Verify Aboard parsing, exact-version downloads, cache isolation, and failed refresh recovery."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from aboard_source import fetch_document, parse_uri, refresh_document


class SourceTests(unittest.TestCase):
    """Use a fake Aboard boundary to test refresh failures without changing remote files."""

    def setUp(self):
        """Create a disposable cache and a controllable remote version."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.version = 1
        self.bad_digest = False
        self.fail = False
        self.calls = []

    def aboard(self, arguments):
        """Return immutable version bytes or a controlled download failure."""
        self.calls.append(arguments)
        if arguments[1] == 'show':
            return {'server': {'url': 'https://aboard.example'}, 'file': {'id': 'fil_test', 'latest': {'version': self.version}}}
        if self.fail:
            raise RuntimeError('download failed')
        version = int(arguments[arguments.index('--version') + 1])
        data = ('# Version ' + str(version)).encode()
        Path(arguments[3]).write_bytes(data)
        return {'version': version, 'server': {'url': 'https://aboard.example'}, 'board': 'leaf',
                'digest': 'bad' if self.bad_digest else 'sha256:' + hashlib.sha256(data).hexdigest()}

    def test_latest_refresh_and_pins_use_separate_cache_paths(self):
        """Latest sources advance while pinned sources remain fixed and never overwrite each other."""
        latest, source = fetch_document('aboard://leaf/notes/plan.md', self.root, runner=self.aboard)
        pinned, fixed = fetch_document('aboard://leaf/notes/plan.md@v1', self.root, runner=self.aboard)
        self.assertNotEqual(latest, pinned)
        self.version = 2
        _, updated = refresh_document(latest, source, self.root, runner=self.aboard)
        _, unchanged = refresh_document(pinned, fixed, self.root, runner=self.aboard)
        self.assertEqual(updated['version'], 2)
        self.assertEqual(unchanged['version'], 1)
        self.assertEqual(Path(pinned).read_text(), '# Version 1')
        self.assertEqual(Path(latest).stat().st_mode & 0o777, 0o600)

    def test_failed_refresh_preserves_previous_bytes(self):
        """Download and digest errors leave the last usable document intact."""
        path, source = fetch_document('aboard://leaf/plan.md', self.root, runner=self.aboard)
        self.version = 2
        self.bad_digest = True
        with self.assertRaisesRegex(RuntimeError, 'digest'):
            refresh_document(path, source, self.root, runner=self.aboard)
        self.assertEqual(Path(path).read_text(), '# Version 1')
        self.bad_digest, self.fail = False, True
        with self.assertRaisesRegex(RuntimeError, 'download failed'):
            refresh_document(path, source, self.root, runner=self.aboard)
        self.assertEqual(Path(path).read_text(), '# Version 1')

    def test_rejects_traversal_flags_and_unsupported_files(self):
        """Untrusted URI components cannot escape the cache or become CLI options."""
        for uri in ('aboard://leaf/../plan.md', 'aboard://leaf/%2e%2e/plan.md', 'aboard://-x/plan.md',
                    'aboard://leaf/-x.md', 'aboard://leaf/a.pdf', 'aboard://leaf/a.md?token=x'):
            with self.assertRaises(ValueError):
                parse_uri(uri)
        self.assertEqual(parse_uri('aboard://leaf/notes/a%20b.md@v3'), ('leaf', 'notes/a b.md', 3))

    def test_refuses_refresh_into_user_document(self):
        """Tampered source paths cannot redirect a refresh outside the calculated cache."""
        _, source = fetch_document('aboard://leaf/plan.md', self.root, runner=self.aboard)
        document = self.root / 'user.md'
        document.write_text('keep')
        with self.assertRaises(ValueError):
            refresh_document(str(document), source, self.root, runner=self.aboard)
        self.assertEqual(document.read_text(), 'keep')
