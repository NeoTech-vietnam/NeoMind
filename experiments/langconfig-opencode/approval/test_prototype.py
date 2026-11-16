import concurrent.futures
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import prototype as p


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / 'approval.sqlite')
        p.initialize(self.path)
        p.create_approval(self.path, 'a', 'task', 'checkpoint')

    def decide(self, key='key', decision='approve', **overrides):
        args = dict(approval_id='a', task_id='task', checkpoint='checkpoint', version=1,
                    decision=decision, request_key=key)
        args.update(overrides)
        return p.decide(self.path, **args)

    def test_concurrent_opposite_decisions(self):
        barrier = threading.Barrier(2)
        def run(decision):
            barrier.wait()
            try:
                return self.decide(key=decision, decision=decision)
            except p.Conflict:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, ('approve', 'reject')))
        self.assertEqual(sum(r is not None for r in results), 1)
        state = p.snapshot(self.path)
        self.assertEqual((len(state['receipts']), len(state['jobs'])), (1, 1))

    def test_concurrent_idempotency_and_key_collision(self):
        barrier = threading.Barrier(2)
        def run(_):
            barrier.wait()
            return self.decide()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(run, range(2)))
        self.assertEqual(receipts[0], receipts[1])
        with self.assertRaises(p.Conflict):
            self.decide(decision='reject')
        self.assertEqual(len(p.snapshot(self.path)['jobs']), 1)

    def test_stale_and_reject(self):
        for overrides in ({'checkpoint': 'old'}, {'version': 2}, {'task_id': 'other'}):
            with self.assertRaises(p.Conflict):
                self.decide(**overrides)
        receipt = self.decide(decision='reject')
        self.assertEqual(receipt['decision'], 'reject')
        with self.assertRaises(p.Conflict):
            self.decide(key='different', decision='approve')
        self.assertEqual(len(p.snapshot(self.path)['jobs']), 1)

    def test_rollback_before_commit_and_recovery_after_commit(self):
        def crash():
            raise RuntimeError('simulated crash')
        with self.assertRaises(RuntimeError):
            self.decide(before_commit=crash)
        state = p.snapshot(self.path)
        self.assertEqual(state['approvals'][0]['status'], 'pending')
        self.assertEqual((state['receipts'], state['jobs']), ([], []))
        receipt = self.decide()
        self.assertEqual(self.decide(), receipt)
        job = p.claim(self.path, 'worker', 10, now=100)
        self.assertTrue(p.finish(self.path, job['id'], 'worker', job['epoch'], now=101))

    def test_process_death_before_commit(self):
        script = "import os, prototype as p; p.decide(os.environ['DB'], 'a', 'task', 'checkpoint', 1, 'approve', 'key', before_commit=lambda: os._exit(7))"
        env = dict(os.environ, DB=self.path)
        result = subprocess.run([sys.executable, '-c', script], cwd=Path(p.__file__).parent, env=env)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(p.snapshot(self.path)['receipts'], [])
        self.decide()

    def test_lease_takeover_fences_database_completion(self):
        self.decide()
        first = p.claim(self.path, 'old', 5, now=100)
        self.assertIsNone(p.claim(self.path, 'new', 5, now=104))
        second = p.claim(self.path, 'new', 5, now=105)
        self.assertGreater(second['epoch'], first['epoch'])
        self.assertFalse(p.finish(self.path, first['id'], 'old', first['epoch'], now=106))
        self.assertTrue(p.finish(self.path, second['id'], 'new', second['epoch'], now=106))


if __name__ == '__main__':
    unittest.main()
