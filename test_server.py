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

    def test_document_stamps_track_edits_and_missing_files(self):
        """Open-tab stamps change after rewrites and become null when files disappear."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / 'note.md'
            path.write_text('one')
            workspace = Workspace(root / 'state.json')
            workspace.action({'action': 'open-file', 'path': str(path)})
            with patch.object(server, 'WORKSPACE', workspace):
                before = server.document_stamps()
                path.write_text('different content')
                self.assertNotEqual(before, server.document_stamps())
                path.unlink()
                self.assertIsNone(server.document_stamps()[str(path)])

    def test_path_completion_is_bounded_authenticated_and_grant_free(self):
        """Suggest supported local entries while excluding hidden files, dependencies, and symlinks."""
        from urllib.parse import quote
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ('notes.md', 'other.md', 'photo.png', '.hidden.md'):
                (root / name).write_text('test')
            (root / 'node_modules').mkdir()
            (root / 'nested').mkdir()
            (root / 'link.md').symlink_to(root / 'notes.md')
            endpoint = '/api/complete?path=' + quote(str(root) + '/')
            self.assertEqual(self.request(endpoint)[0], 403)
            grants = dict(server.FILES)
            code, body = self.request(endpoint, headers={'X-Leaf-Token': server.TOKEN})
            self.assertEqual(code, 200)
            self.assertEqual({Path(item['path']).name for item in json.loads(body)}, {'notes.md', 'other.md', 'nested'})
            self.assertEqual(server.FILES, grants)
            self.assertEqual([Path(item['path']).name for item in server.complete_paths(str(root / 'not'))], ['notes.md'])
            for index in range(60):
                (root / f'doc{index}.md').write_text('test')
            self.assertEqual(len(server.complete_paths(str(root))), 50)
            with self.assertRaises(ValueError):
                server.complete_paths('relative')

    def test_collection_hydration_and_cli(self):
        """Collection CLI operations grant unopen documents and report missing references."""
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace = Workspace(root / 'workspace.json')
            (root / 'connection.json').write_text(json.dumps({'url': self.url, 'token': server.TOKEN}))
            document = root / 'note.md'
            document.write_text('# Note')
            env = dict(os.environ, LEAF_STATE_DIR=str(root))
            server.SESSIONS.clear()
            with patch.object(server, 'WORKSPACE', workspace):
                for arguments in (['collection', 'new', 'Atlas', '--paths', str(document)],
                                  ['collection', 'new', 'Plans', '--parent', 'Atlas'],
                                  ['collection', 'add', 'Atlas/Plans', str(document)],
                                  ['collection', 'rename', 'Atlas/Plans', 'Design'],
                                  ['collection', 'color', 'Atlas', 'green']):
                    result = subprocess.run([sys.executable, str(server.BASE / 'leaf.py'), *arguments, '--json'], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)['status'], 'saved')
                self.assertEqual(workspace.data['tabs'], [])
                hydrated = server.hydrate_workspace()
                self.assertEqual(hydrated['entries'][0]['path'], str(document))
                document.unlink()
                hydrated = server.hydrate_workspace()
                self.assertIn('error', hydrated['entries'][0])
                self.assertEqual(hydrated['missing'][0]['path'], str(document))

    def test_group_cli_roundtrip(self):
        """CLI group commands share the server workspace and retain state across reloads."""
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace = Workspace(root / 'workspace.json')
            (root / 'connection.json').write_text(json.dumps({'url': self.url, 'token': server.TOKEN}))
            document = root / 'note.md'
            document.write_text('# Note')
            env = dict(os.environ, LEAF_STATE_DIR=str(root))
            server.SESSIONS.clear()
            with patch.object(server, 'WORKSPACE', workspace):
                for arguments in (['group', 'new', 'Project', '--color', 'green'],
                                  ['open', str(document), '--group', 'Project', '--no-browser'],
                                  ['reader', '--font-size', '18', '--width', 'wide'],
                                  ['group', 'update', 'Project', '--collapsed', 'true'],
                                  ['group', 'close', 'Project'], ['group', 'open', 'Project'],
                                  ['move-tab', str(document), '0', '--group', 'none']):
                    result = subprocess.run([sys.executable, str(server.BASE / 'leaf.py'), *arguments, '--json'], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)['status'], 'saved')
            restored = Workspace(workspace.path).data
            self.assertIsNone(restored['tabs'][0]['group'])
            self.assertEqual(restored['reader']['fontSize'], 18)
            self.assertEqual(restored['groups'][0]['color'], 'green')

    def test_comments_api_and_cli_keep_timeline_without_rescans(self):
        """Real CLI transitions persist and comment-only synchronization avoids folder scans."""
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            document = root / 'plan.md'
            document.write_text('# Plan\nA **bold** statement.')
            workspace = Workspace(root / 'workspace.json')
            workspace.action({'action': 'open-file', 'path': str(document)})
            (root / 'connection.json').write_text(json.dumps({'url': self.url, 'token': server.TOKEN}))
            env = dict(os.environ, LEAF_STATE_DIR=str(root), LEAF_AUTHOR='test-agent')
            server.SESSIONS.clear()
            headers = {'X-Leaf-Token': server.TOKEN}
            self.assertEqual(self.request('/api/comments')[0], 403)
            with patch.object(server, 'WORKSPACE', workspace), patch.object(server, 'COMMENT_REVISIONS', set()):
                base = workspace.data['revision']
                result = subprocess.run([sys.executable, str(server.BASE / 'leaf.py'), 'comment', 'add', str(document),
                                         'Clarify', '--quote', 'A bold statement.', '--json'], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                thread = json.loads(result.stdout)['comments'][0]
                self.assertEqual(thread['author'], 'test-agent')
                for operation in ('working', 'resolve', 'reopen'):
                    result = subprocess.run([sys.executable, str(server.BASE / 'leaf.py'), 'comment', operation,
                                             thread['id'], 'Update', '--author', 'codex', '--json'], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                with patch.object(server, 'scan_folder', side_effect=AssertionError('Unexpected rescan')):
                    code, body = self.request('/api/sync', {'session': 'comments-test', 'instance': server.SERVER_INSTANCE,
                                                          'revision': base}, headers)
                    self.assertEqual(code, 200)
                    self.assertNotIn('entries', json.loads(body))
                    self.assertEqual(len(json.loads(body)['workspace']['comments'][0]['replies']), 3)
                code, body = self.request('/api/comments', headers=headers)
                self.assertEqual(json.loads(body)['comments'][0]['location']['line'], 2)
                self.assertEqual(json.loads(self.request('/api/comments?status=resolved', headers=headers)[1])['comments'], [])
                result = subprocess.run([sys.executable, str(server.BASE / 'leaf.py'), 'comments', '--format', 'md'],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('marked resolved: Update', result.stdout)
                self.assertEqual(document.read_text(), '# Plan\nA **bold** statement.')
                server.SESSIONS.clear()

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
