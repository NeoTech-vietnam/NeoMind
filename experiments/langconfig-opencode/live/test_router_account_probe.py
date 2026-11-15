import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import router_account_probe as probe


class AccountProbeTests(unittest.TestCase):
    def run_probe(self, available):
        with tempfile.TemporaryDirectory(dir=probe.ROOT / 'tmp') as directory:
            root = Path(directory)
            (root / 'runs').mkdir()
            worker = MagicMock()
            worker.model = {'providerID': 'openrouter', 'id': 'openrouter/free'}
            worker.request.side_effect = [
                {'data': {'connections': [{'type': 'credential'}] if available else []}},
                {'data': {'model': worker.model, 'permissions': probe.PERMISSIONS,
                          'location': {'directory': str(root / 'runs' / 'probe' / 'fixture')}}},
            ]
            output = io.StringIO()
            with patch.object(probe, 'ROOT', root), patch.object(probe, 'verify_live_budget'), \
                    patch.object(probe.tempfile, 'mkdtemp', return_value=str(root / 'runs' / 'probe')), \
                    patch.object(probe, 'Worker', return_value=worker), patch.object(probe.threading, 'Event'), \
                    contextlib.redirect_stdout(output):
                (root / 'runs' / 'probe').mkdir()
                probe.main()
            worker.close.assert_called_once()
            self.assertTrue(all('/prompt' not in call.args[1] for call in worker.request.call_args_list))
            return output.getvalue().splitlines()

    def test_success_reports_done_without_inference(self):
        lines = self.run_probe(True)
        self.assertEqual(json.loads(lines[0])['status'], 'preflight-ok')
        self.assertEqual(lines[-1], 'PROBE_DONE')

    def test_failure_cannot_report_success(self):
        lines = self.run_probe(False)
        self.assertEqual(json.loads(lines[0])['status'], 'preflight-failed')
        self.assertEqual(lines[-1], 'PROBE_FAILED')


if __name__ == '__main__':
    unittest.main(verbosity=2)
