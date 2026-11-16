"""LocalRun scheduler crash and fail-closed recovery, with no real agent process."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'broker'))
import create_fixture


class LocalRunCrashRecoveryTests(unittest.TestCase):
    def test_recovery_retains_writer_lease_when_stop_cannot_be_verified(self):
        if sys.platform != 'linux':
            self.skipTest('Fixture uses Linux process-identity recovery')
        with tempfile.TemporaryDirectory(prefix='neomind-localrun-crash-') as directory:
            root = Path(directory)
            source = create_fixture.create(root / 'source')
            run_root = root / 'run'
            run_root.mkdir()
            script = Path(__file__).with_name('localrun-crash-fixture.mjs')
            env = {'PATH': '/usr/bin:/bin', 'HOME': '/dev/null', 'LANG': 'C.UTF-8',
                   'TMPDIR': str(run_root),
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                   'GIT_TERMINAL_PROMPT': '0', 'GIT_ALLOW_PROTOCOL': 'file'}
            crashed = subprocess.run(['node', str(script), 'crash', str(source), str(run_root)],
                                     env=env, capture_output=True, text=True, timeout=40)
            self.assertEqual(crashed.returncode, 73, crashed.stderr)
            self.assertEqual((run_root / 'dispatch-count').read_text(), 'dispatch\n')
            with sqlite3.connect(run_root / 'state' / 'coordination.sqlite') as db:
                self.assertEqual(db.execute('SELECT count(*) FROM run_owner').fetchone()[0], 1)
                before = db.execute('SELECT workspace, run_id, host_id, fence, quarantined FROM workspace_writer').fetchone()
                self.assertIsNotNone(before)
            for _ in range(2):
                recovered = subprocess.run(['node', str(script), 'recover', str(source), str(run_root)],
                                           env=env, capture_output=True, text=True, timeout=40)
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                result = json.loads(recovered.stdout)
                self.assertEqual(result['phase'], 'blocked')
                self.assertIn('Worker stop is unconfirmed', result['reason'])
                self.assertEqual(result['unresolved'], 1)
                self.assertTrue(result['leaseRetained'])
                self.assertEqual(result['dispatches'], 1)
                with sqlite3.connect(run_root / 'state' / 'coordination.sqlite') as db:
                    self.assertEqual(db.execute('SELECT workspace, run_id, host_id, fence, quarantined FROM workspace_writer').fetchone(), before)
            self.assertEqual((run_root / 'dispatch-count').read_text(), 'dispatch\n')


if __name__ == '__main__':
    unittest.main()
