import subprocess
import os
import sys
import tempfile
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import quota
from runtime_paths import require_data_root

ROOT = Path(__file__).resolve().parent
DATA = require_data_root()

class QuotaTests(unittest.TestCase):
    def test_process_concurrency_restart_and_fail_closed(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            db = str(Path(directory) / 'quota.sqlite')
            quota.initialize(db, 7)
            quota.bind(db, 'ses_a', 'w', 7)
            processes = [subprocess.Popen([sys.executable, str(ROOT / 'quota.py'), 'reserve', db, 'ses_a', f'id-{i}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for i in range(30)]
            self.assertEqual(sum(p.wait() == 0 for p in processes), 7)
            with closing(quota.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM reservations').fetchone()[0], 7)
            with self.assertRaises(ValueError):
                quota.reserve(db, 'ses_a', 'after-restart')
            with self.assertRaises(Exception):
                quota.reserve(str(Path(directory) / 'missing.sqlite'), 'ses_a', 'x')
            with self.assertRaises(ValueError):
                quota.bind(db, 'ses_b', 'w', 8)

    def test_per_workflow_and_global_limits(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            db = str(Path(directory) / 'quota.sqlite')
            quota.initialize(db, 3)
            quota.bind(db, 'ses_a', 'a', 1)
            quota.bind(db, 'ses_b', 'b', 3)
            quota.reserve(db, 'ses_a', '1')
            with self.assertRaises(ValueError): quota.reserve(db, 'ses_a', '2')
            quota.reserve(db, 'ses_b', '3')
            quota.reserve(db, 'ses_b', '4')
            with self.assertRaises(ValueError): quota.reserve(db, 'ses_b', '5')

    def test_live_workflow_limit_and_committed_reservation_survives_exit(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            db = str(Path(directory) / 'quota.sqlite')
            quota.initialize(db, 40)
            for index in range(4):
                quota.start_workflow(db, f'w{index}', 10)
                quota.bind(db, f'ses_{index}', f'w{index}', 10)
            with self.assertRaises(ValueError):
                quota.start_workflow(db, 'fifth', 10)
            completed = subprocess.run([sys.executable, str(ROOT / 'quota.py'), 'reserve', db, 'ses_0', 'committed'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.assertEqual(completed.returncode, 0)
            with closing(quota.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM reservations').fetchone()[0], 1)

    def test_attempt_reuse_rejected_but_existing_workflow_accepts_more_sessions(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            db = str(Path(directory) / 'quota.sqlite')
            quota.initialize(db, 40)
            quota.start_workflow(db, 'attempt-1', 10)
            with self.assertRaises(FileExistsError):
                quota.initialize(db, 40)
            with self.assertRaises(ValueError):
                quota.start_workflow(db, 'attempt-1', 10)
            quota.bind(db, 'ses_one', 'attempt-1', 10)
            quota.bind(db, 'ses_two', 'attempt-1', 10)
            with closing(quota.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM workflows').fetchone()[0], 1)
                self.assertEqual(conn.execute('SELECT count(*) FROM sessions').fetchone()[0], 2)

    def test_concurrent_new_workflows_cannot_exceed_four(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            db = str(Path(directory) / 'quota.sqlite')
            quota.initialize(db, 40)
            def attempt(index):
                try:
                    quota.start_workflow(db, f'attempt-{index}', 10)
                    return True
                except ValueError:
                    return False
            with ThreadPoolExecutor(max_workers=10) as pool:
                self.assertEqual(sum(pool.map(attempt, range(10))), 4)
            with closing(quota.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM workflows').fetchone()[0], 4)

if __name__ == '__main__':
    unittest.main(verbosity=2)
