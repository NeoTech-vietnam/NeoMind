import tempfile
import unittest
from pathlib import Path

from fake_acceptance import MODEL, PERMISSIONS, ROOT
from runner_turn import execute


class Worker:
    def __init__(self, root, admitted=True):
        self.workspace = root
        self.admitted = admitted
        self.message = None
        self.posts = 0

    def request(self, method, path, body=None, timeout=30):
        if path.endswith('/prompt'):
            self.posts += 1
            self.message = body['id'] if self.admitted else None
            raise TimeoutError('receipt lost')
        if path.endswith('/wait'):
            return None
        return {'data': {'outcome': 'succeeded', 'model': MODEL, 'permissions': PERMISSIONS, 'agent': 'build',
                         'location': {'directory': str(self.workspace)}, 'metadata': {'neomindSession': 'logical'}}}

    def timeline(self, sid):
        return ([{'type': 'user', 'id': self.message}, {'type': 'assistant', 'model': MODEL, 'agent': 'build', 'finish': 'stop',
                  'content': [{'type': 'text', 'text': '{"verdict":"pass","findings":[],"summary":"ok"}'}]}] if self.message else [])


class TurnJournalTests(unittest.TestCase):
    def test_lost_receipt_recovers_and_caches_without_resubmit(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tmp') as directory:
            root = Path(directory); worker = Worker(root)
            args = (worker, root, 'workflow', 'logical', 'ses_1', MODEL, 'turn1', 'synthetic')
            first = execute(*args)
            self.assertEqual(execute(*args), first)
            self.assertEqual(worker.posts, 1)
            with self.assertRaises(ValueError): execute(*args[:-1], 'different prompt')

    def test_unknown_admission_never_resubmits(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tmp') as directory:
            root = Path(directory); worker = Worker(root, admitted=False)
            args = (worker, root, 'workflow', 'logical', 'ses_1', MODEL, 'turn1', 'synthetic')
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, 'no retry'): execute(*args)
            self.assertEqual(worker.posts, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
