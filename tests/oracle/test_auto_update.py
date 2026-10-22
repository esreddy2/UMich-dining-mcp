"""Offline unit checks for Oracle's opt-in published-release updater."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SOURCE = Path(__file__).parents[2] / 'deploy' / 'oracle' / 'auto-update.py'
spec = importlib.util.spec_from_file_location('umich_oracle_updater', SOURCE)
assert spec and spec.loader
up = importlib.util.module_from_spec(spec)
spec.loader.exec_module(up)


class ReleaseSafetyTests(unittest.TestCase):
    def test_stable_tags_only(self):
        self.assertEqual(up.tag_version('v0.2.1'), (0, 2, 1))
        self.assertEqual(up.tag_version('v2.10.0'), (2, 10, 0))
        for value in ('0.2.1', 'v0.2.1-rc.1', 'v0.2.1;rm', 'v2.1', 'v2.1.0/../'):
            self.assertIsNone(up.tag_version(value))

    @patch.object(up, 'json_request')
    def test_semver_not_string_order(self, fetch):
        fetch.return_value = [
            {'name': 'v0.2.9', 'commit': {'sha': 'a' * 40}},
            {'name': 'v0.2.10', 'commit': {'sha': 'b' * 40}},
            {'name': 'v0.3.0-rc.1', 'commit': {'sha': 'c' * 40}},
            {'name': 'v999.0.0', 'commit': {'sha': 'MALICIOUS'}},
        ]
        self.assertEqual(up.next_release(), ((0, 2, 10), 'v0.2.10', 'b' * 40))

    @patch.object(up, 'request')
    def test_rejects_path_traversal(self, fetch):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('repo/../../evil', 'evil')
        fetch.return_value = buf.getvalue()
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'Unsafe archive'):
                up.download_and_unpack('a' * 40, Path(temp))
            self.assertFalse((Path(temp).parent / 'evil').exists())

    @patch.object(up, 'request')
    def test_accepts_simple_repo_zip_and_checks_version(self, fetch):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('repo/package.json', json.dumps({'name': 'umich-dining-mcp', 'version': '0.2.1'}))
            z.writestr('repo/package-lock.json', json.dumps({
                'version': '0.2.1', 'packages': {'': {'version': '0.2.1'}}
            }))
            z.writestr('repo/src/http-server.ts', 'export {}')
        fetch.return_value = buf.getvalue()
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            up.download_and_unpack('a' * 40, stage)
            up.require_release_version(stage, '0.2.1')
            with self.assertRaisesRegex(RuntimeError, 'version differs'):
                up.require_release_version(stage, '0.2.2')


    def test_failed_health_restores_previous_release(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp) / 'app'
            releases = base / 'releases'
            releases.mkdir(parents=True)
            old = releases / '0.2.0-original'
            old.mkdir()
            current = base / 'current'
            current.symlink_to('releases/0.2.0-original')
            state = Path(temp) / 'state'
            state.mkdir()
            sha = 'a' * 40
            with (patch.object(up, 'BASE', base),
                  patch.object(up, 'RELEASES', releases),
                  patch.object(up, 'CURRENT', current),
                  patch.object(up, 'STATE', state),
                  patch.object(up, 'upstream_available'),
                  patch.object(up, 'download_and_unpack'),
                  patch.object(up, 'require_release_version'),
                  patch.object(up, 'build_as_unprivileged_user'),
                  patch.object(up, 'run') as restart,
                  patch.object(up, 'wait_healthy', side_effect=[False, True])):
                with self.assertRaisesRegex(RuntimeError, 'health check'):
                    up.deploy((0, 2, 1), sha)
                self.assertEqual(current.resolve(), old)
                self.assertEqual(restart.call_count, 2)
                self.assertTrue((state / ('failed-' + sha)).exists())


if __name__ == '__main__':
    unittest.main()
