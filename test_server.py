"""Exercise the local bridge access boundary and explicit session targeting."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from workspace import Workspace
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import server


class BridgeTests(unittest.TestCase):
    """Keep browser simulation separate from the real reader session."""

    @classmethod
    def setUpClass(cls):
        """Run the handler on an ephemeral loopback port without runtime credentials."""
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.url = f'http://127.0.0.1:{cls.http.server_port}'
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        """Close the test listener after all requests finish."""
        cls.http.shutdown()
        cls.http.server_close()

    def request(self, path, data=None, headers=None):
        """Return status and body for both successful and rejected requests."""
        request = Request(self.url + path, data=json.dumps(data).encode() if data is not None else None,
                          headers=headers or {})
        try:
            with urlopen(request) as response:
                return response.status, response.read()
        except HTTPError as error:
            with error:
                return error.code, error.read()

    def test_access_boundary(self):
        """Reject missing tokens, foreign origins, spoofed hosts, and unlisted assets."""
        self.assertEqual(self.request('/api/sessions')[0], 403)
        self.assertEqual(self.request('/api/sessions', headers={'X-Leaf-Token': server.TOKEN, 'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request('/', headers={'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.request('/server.py')[0], 404)
        self.assertEqual(self.request('/api/file?id=unknown', headers={'X-Leaf-Token': server.TOKEN})[0], 400)

    def test_built_assets_are_contained_and_tokenized(self):
        """Serve build assets but reject traversal, escaped symlinks, and source files."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dist = root / 'web/dist'
            (dist / 'assets').mkdir(parents=True)
            (dist / 'index.html').write_text('<meta name="leaf-agent-token" content="__LEAF_TOKEN__">')
            (dist / 'assets/app.js').write_text('console.log("Leaf")')
            (root / 'private.txt').write_text('private')
            (dist / 'assets/escape.js').symlink_to(root / 'private.txt')
            with patch.object(server, 'BASE', root):
                code, body = self.request('/')
                self.assertEqual(code, 200)
                self.assertIn(server.TOKEN.encode(), body)
                self.assertNotIn(b'__LEAF_TOKEN__', body)
                self.assertEqual(self.request('/assets/app.js')[0], 200)
                for path in ('/assets/../../../private.txt', '/assets/escape.js', '/server.py', '/assets/missing.js'):
                    self.assertEqual(self.request(path)[0], 404, path)
                (dist / 'index.html').unlink()
                self.assertEqual(self.request('/')[0], 503)

    def test_explicit_session_and_receipt(self):
        """Reject ambiguous readers and acknowledge only the addressed session."""
        headers = {'X-Leaf-Token': server.TOKEN}
        server.SESSIONS.clear()
        for session in ['first', 'second']:
            self.request('/api/poll', {'session': session, 'state': {}}, headers)
        self.assertEqual(self.request('/api/command', {'action': 'state'}, headers)[0], 400)
        code, body = self.request('/api/command', {'action': 'state', 'session': 'first'}, headers)
        self.assertEqual(code, 200)
        command_id = json.loads(body)['id']
        _, body = self.request('/api/poll', {'session': 'second', 'state': {}}, headers)
        self.assertEqual(json.loads(body), [])
        _, body = self.request('/api/poll', {'session': 'first', 'state': {}}, headers)
        self.assertEqual(json.loads(body)[0]['id'], command_id)
        self.assertEqual(self.request('/api/ack', {'id': command_id, 'session': 'second'}, headers)[0], 400)
        self.request('/api/ack', {'id': command_id, 'session': 'first', 'state': {'active': 'example.md'}}, headers)
        self.assertEqual(server.COMMANDS[command_id]['status'], 'applied')

    def test_folder_grants_and_expiration(self):
        """Skip hidden files and links, and never deliver stale queued commands."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'note.md').write_text('# A note')
            (root / '.secret.md').write_text('hidden')
            (root / 'link.md').symlink_to(root / 'note.md')
            entries = server.scan_folder(root)
            self.assertEqual([entry['path'] for entry in entries], ['note.md'])
        server.COMMANDS['old'] = {'session': 'expired', 'status': 'queued', 'created': time.time() - 30, 'command': {'action': 'state'}}
        _, body = self.request('/api/poll', {'session': 'expired', 'state': {}}, {'X-Leaf-Token': server.TOKEN})
        self.assertEqual(json.loads(body), [])
        self.assertEqual(server.COMMANDS['old']['status'], 'expired')

    def test_restart_refreshes_grants_and_keeps_missing_tabs(self):
        """A new server instance sends fresh file grants even at the same saved revision."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            document = root / 'note.md'
            document.write_text('# Note')
            workspace = Workspace(root / 'workspace.json')
            workspace.action({'action': 'open-file', 'path': str(document)})
            with patch.object(server, 'WORKSPACE', workspace):
                headers = {'X-Leaf-Token': server.TOKEN}
                code, body = self.request('/api/sync', {'session': 'restart-test', 'revision': workspace.data['revision'], 'instance': 'old-process', 'state': {}}, headers)
                self.assertEqual(code, 200)
                payload = json.loads(body)
                self.assertIn('id', payload['entries'][0])
                document.unlink()
                code, body = self.request('/api/workspace', headers=headers)
                payload = json.loads(body)
                self.assertIn('error', payload['entries'][0])
                self.assertEqual(len(payload['workspace']['tabs']), 1)

    def test_stale_sync_returns_canonical_workspace(self):
        """An outdated browser receives the current workspace instead of erasing new state."""
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory) / 'workspace.json')
            old = dict(workspace.data)
            workspace.action({'action': 'theme', 'path': 'dark'})
            with patch.object(server, 'WORKSPACE', workspace):
                code, body = self.request('/api/sync', {'session': 'stale-test', 'revision': old['revision'], 'instance': server.SERVER_INSTANCE, 'view': old, 'state': {}}, {'X-Leaf-Token': server.TOKEN})
                self.assertEqual(code, 200)
                self.assertEqual(json.loads(body)['workspace']['theme'], 'dark')


if __name__ == '__main__':
    unittest.main()
